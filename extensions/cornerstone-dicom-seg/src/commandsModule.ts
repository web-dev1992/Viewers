import dcmjs from 'dcmjs';
import { Types } from '@ohif/core';
import html2canvas from 'html2canvas';
import {
  cache,
  metaData,
  getEnabledElement,
  StackViewport,
  BaseVolumeViewport,
} from '@cornerstonejs/core';
import { PDFDocument, rgb } from 'pdf-lib';
import {
  segmentation as cornerstoneToolsSegmentation,
  Enums as cornerstoneToolsEnums,
  utilities,
} from '@cornerstonejs/tools';
import { adaptersRT, helpers, adaptersSEG } from '@cornerstonejs/adapters';
import { createReportDialogPrompt } from '@ohif/extension-default';
import { classes, DicomMetadataStore } from '@ohif/core';

import vtkImageMarchingSquares from '@kitware/vtk.js/Filters/General/ImageMarchingSquares';
import vtkDataArray from '@kitware/vtk.js/Common/Core/DataArray';
import vtkImageData from '@kitware/vtk.js/Common/DataModel/ImageData';
import PROMPT_RESPONSES from '../../default/src/utils/_shared/PROMPT_RESPONSES';

const { segmentation: segmentationUtils } = utilities;

const { datasetToBlob } = dcmjs.data;

const getTargetViewport = ({ viewportId, viewportGridService }) => {
  const { viewports, activeViewportId } = viewportGridService.getState();
  const targetViewportId = viewportId || activeViewportId;

  const viewport = viewports.get(targetViewportId);

  return viewport;
};

const {
  Cornerstone3D: {
    Segmentation: { generateSegmentation },
  },
} = adaptersSEG;

const {
  Cornerstone3D: {
    RTSS: { generateRTSSFromSegmentations },
  },
} = adaptersRT;

const { downloadDICOMData } = helpers;

const commandsModule = ({
  servicesManager,
  extensionManager,
}: Types.Extensions.ExtensionParams): Types.Extensions.CommandsModule => {
  const {
    segmentationService,
    uiDialogService,
    displaySetService,
    viewportGridService,
    toolGroupService,
    customizationService,
    cornerstoneViewportService,
  } = servicesManager.services as AppTypes.Services;

  const VIEWPORT_ID = 'segmentation-viewport-download-form';
  const DEFAULT_SIZE = 512;
  const MAX_TEXTURE_SIZE = 10000;

  const actions = {
    /**
     * Loads segmentations for a specified viewport.
     * The function prepares the viewport for rendering, then loads the segmentation details.
     * Additionally, if the segmentation has scalar data, it is set for the corresponding label map volume.
     *
     * @param {Object} params - Parameters for the function.
     * @param params.segmentations - Array of segmentations to be loaded.
     * @param params.viewportId - the target viewport ID.
     *
     */
    loadSegmentationsForViewport: async ({ segmentations, viewportId }) => {
      // Todo: handle adding more than one segmentation
      const viewport = getTargetViewport({ viewportId, viewportGridService });
      const displaySetInstanceUID = viewport.displaySetInstanceUIDs[0];

      const segmentation = segmentations[0];
      const segmentationId = segmentation.segmentationId;
      const label = segmentation.config.label;
      const segments = segmentation.config.segments;

      const displaySet = displaySetService.getDisplaySetByUID(displaySetInstanceUID);

      await segmentationService.createLabelmapForDisplaySet(displaySet, {
        segmentationId,
        segments,
        label,
      });

      segmentationService.addOrUpdateSegmentation(segmentation);

      await segmentationService.addSegmentationRepresentation(viewport.viewportId, {
        segmentationId,
      });

      return segmentationId;
    },
    /**
     * Generates a segmentation from a given segmentation ID.
     * This function retrieves the associated segmentation and
     * its referenced volume, extracts label maps from the
     * segmentation volume, and produces segmentation data
     * alongside associated metadata.
     *
     * @param {Object} params - Parameters for the function.
     * @param params.segmentationId - ID of the segmentation to be generated.
     * @param params.options - Optional configuration for the generation process.
     *
     * @returns Returns the generated segmentation data.
     */
    generateSegmentation: ({ segmentationId, options = {} }) => {
      const segmentation = cornerstoneToolsSegmentation.state.getSegmentation(segmentationId);

      const { imageIds } = segmentation.representationData.Labelmap;

      const segImages = imageIds.map(imageId => cache.getImage(imageId));
      const referencedImages = segImages.map(image => cache.getImage(image.referencedImageId));

      const labelmaps2D = [];

      let z = 0;

      for (const segImage of segImages) {
        const segmentsOnLabelmap = new Set();
        const pixelData = segImage.getPixelData();
        const { rows, columns } = segImage;

        // Use a single pass through the pixel data
        for (let i = 0; i < pixelData.length; i++) {
          const segment = pixelData[i];
          if (segment !== 0) {
            segmentsOnLabelmap.add(segment);
          }
        }

        labelmaps2D[z++] = {
          segmentsOnLabelmap: Array.from(segmentsOnLabelmap),
          pixelData,
          rows,
          columns,
        };
      }

      const allSegmentsOnLabelmap = labelmaps2D.map(labelmap => labelmap.segmentsOnLabelmap);

      const labelmap3D = {
        segmentsOnLabelmap: Array.from(new Set(allSegmentsOnLabelmap.flat())),
        metadata: [],
        labelmaps2D,
      };

      const segmentationInOHIF = segmentationService.getSegmentation(segmentationId);
      const representations = segmentationService.getRepresentationsForSegmentation(segmentationId);

      Object.entries(segmentationInOHIF.segments).forEach(([segmentIndex, segment]) => {
        // segmentation service already has a color for each segment
        if (!segment) {
          return;
        }

        const { label } = segment;

        const firstRepresentation = representations[0];
        const color = segmentationService.getSegmentColor(
          firstRepresentation.viewportId,
          segmentationId,
          segment.segmentIndex
        );

        const RecommendedDisplayCIELabValue = dcmjs.data.Colors.rgb2DICOMLAB(
          color.slice(0, 3).map(value => value / 255)
        ).map(value => Math.round(value));

        const segmentMetadata = {
          SegmentNumber: segmentIndex.toString(),
          SegmentLabel: label,
          SegmentAlgorithmType: segment?.algorithmType || 'MANUAL',
          SegmentAlgorithmName: segment?.algorithmName || 'OHIF Brush',
          RecommendedDisplayCIELabValue,
          SegmentedPropertyCategoryCodeSequence: {
            CodeValue: 'T-D0050',
            CodingSchemeDesignator: 'SRT',
            CodeMeaning: 'Tissue',
          },
          SegmentedPropertyTypeCodeSequence: {
            CodeValue: 'T-D0050',
            CodingSchemeDesignator: 'SRT',
            CodeMeaning: 'Tissue',
          },
        };
        labelmap3D.metadata[segmentIndex] = segmentMetadata;
      });

      const generatedSegmentation = generateSegmentation(
        referencedImages,
        labelmap3D,
        metaData,
        options
      );

      return generatedSegmentation;
    },
    /**
     * Downloads a segmentation based on the provided segmentation ID.
     * This function retrieves the associated segmentation and
     * uses it to generate the corresponding DICOM dataset, which
     * is then downloaded with an appropriate filename.
     *
     * @param {Object} params - Parameters for the function.
     * @param params.segmentationId - ID of the segmentation to be downloaded.
     *
     */
    downloadSegmentation: ({ segmentationId }) => {
      const segmentationInOHIF = segmentationService.getSegmentation(segmentationId);
      const generatedSegmentation = actions.generateSegmentation({
        segmentationId,
      });

      downloadDICOMData(generatedSegmentation.dataset, `${segmentationInOHIF.label}`);
    },

    /**
     * Sends segmentation info (based on the provided segmentation ID)
     *  and the viewport image  to the backend to provide a pdf file.
     * This function retrieves the associated segmentation and
     * uses it to generate the corresponding DICOM dataset, which
     * is then downloaded with an appropriate filename.
     *
     * @param {Object} params - Parameters for the function.
     * @param params.segmentationId - ID of the segmentation to be downloaded.
     *
     */
    // downloadSegmentationPdf: ({ segmentationId }) => {
    //   const segmentationInOHIF = segmentationService.getSegmentation(segmentationId);
    //   const generatedSegmentation = actions.generateSegmentation({
    //     segmentationId,
    //   });
    //   console.table(generatedSegmentation.dataset);
    //   downloadDICOMData(generatedSegmentation.dataset, `${segmentationInOHIF.label}`);
    //   //TODO: find the viewport image and send it to backend to overlay the segmentation dataset on the image
    // },

    downloadSegmentationPdf: async ({ segmentationId, viewportId = null }) => {
      try {
        // 1. Get the segmentation data
        const segmentationInOHIF = segmentationService.getSegmentation(segmentationId);
        if (!segmentationInOHIF) {
          throw new Error('Segmentation not found');
        }

        // First try to get the segmentation from the state
        let segmentation;
        try {
          segmentation = cornerstoneToolsSegmentation.state.getSegmentation(segmentationId);
          if (!segmentation || !segmentation.representationData?.Labelmap?.imageIds) {
            throw new Error('Invalid segmentation data');
          }
        } catch (error) {
          console.error('Error getting segmentation:', error);
          throw new Error('Failed to load segmentation data');
        }

        // 2. Get the viewport element to capture
        const targetViewportId = viewportId || viewportGridService.getActiveViewportId();
        const viewportElement = document.querySelector(
          `div[data-viewport-uid="${targetViewportId}"]`
        );

        if (!viewportElement) {
          throw new Error('Viewport element not found');
        }

        // 3. Capture the viewport as an image first since it's less likely to fail
        const canvas = await html2canvas(viewportElement as HTMLElement);

        // 4. Now try to generate the segmentation data
        let generatedSegmentation;
        try {
          generatedSegmentation = actions.generateSegmentation({
            segmentationId,
          });
        } catch (error) {
          console.error('Error generating segmentation:', error);
          // Continue with just the viewport image if segmentation fails
          generatedSegmentation = {
            metadata: [],
          };
        }

        // 5. Create PDF and add both the image and segmentation info
        const pdfDoc = await PDFDocument.create();
        const page = pdfDoc.addPage([canvas.width, canvas.height]);

        // Add the viewport image
        const pngImage = await pdfDoc.embedPng(canvas.toDataURL('image/png'));
        page.drawImage(pngImage, {
          x: 0,
          y: 0,
          width: canvas.width,
          height: canvas.height,
        });

        // Add segmentation information as text
        const { metadata = [] } = generatedSegmentation; // Default to empty array if metadata is undefined
        const segmentInfo =
          metadata.length > 0
            ? metadata
                .map(segment => `- Segment ${segment.SegmentNumber}: ${segment.SegmentLabel}`)
                .join('\n')
            : 'No segment metadata available';

        const textContent = [
          `Segmentation: ${segmentationInOHIF.label || 'Unnamed Segmentation'}`,
          `Segments: ${metadata.length}`,
          segmentInfo,
        ].join('\n');

        // Draw text with a background for better readability
        const textWidth = 400;
        const textHeight = 20 + metadata.length * 15;
        page.drawRectangle({
          x: 30,
          y: canvas.height - textHeight - 30,
          width: textWidth,
          height: textHeight + 20,
          color: rgb(0, 0, 0),
          opacity: 0.7,
        });

        page.drawText(textContent, {
          x: 50,
          y: canvas.height - 50,
          size: 12,
          color: rgb(1, 1, 1), // White text
          lineHeight: 15,
        });

        // 6. Generate and download the PDF
        const pdfBytes = await pdfDoc.save();
        const blob = new Blob([pdfBytes], { type: 'application/pdf' });
        const url = URL.createObjectURL(blob);

        const link = document.createElement('a');
        link.download = `${segmentationInOHIF.label || 'segmentation'}.pdf`;
        link.href = url;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);

        // Clean up
        setTimeout(() => URL.revokeObjectURL(url), 100);
      } catch (error) {
        console.error('Error generating segmentation PDF:', error);
        // uiDialogService.showErrorDialog({
        //   title: 'PDF Generation Failed',
        //   message: error.message || 'An error occurred while generating the PDF',
        // });
        throw error;
      }
    },
    /**
     * Stores a segmentation based on the provided segmentationId into a specified data source.
     * The SeriesDescription is derived from user input or defaults to the segmentation label,
     * and in its absence, defaults to 'Research Derived Series'.
     *
     * @param {Object} params - Parameters for the function.
     * @param params.segmentationId - ID of the segmentation to be stored.
     * @param params.dataSource - Data source where the generated segmentation will be stored.
     *
     * @returns {Object|void} Returns the naturalized report if successfully stored,
     * otherwise throws an error.
     */
    storeSegmentation: async ({ segmentationId, dataSource }) => {
      const segmentation = segmentationService.getSegmentation(segmentationId);

      if (!segmentation) {
        throw new Error('No segmentation found');
      }

      const { label } = segmentation;
      const defaultDataSource = dataSource ?? extensionManager.getActiveDataSource();

      const {
        value: reportName,
        dataSourceName: selectedDataSource,
        action,
      } = await createReportDialogPrompt({
        servicesManager,
        extensionManager,
        title: 'Store Segmentation',
      });

      if (action === PROMPT_RESPONSES.CREATE_REPORT) {
        try {
          const selectedDataSourceConfig = selectedDataSource
            ? extensionManager.getDataSources(selectedDataSource)[0]
            : defaultDataSource;

          const generatedData = actions.generateSegmentation({
            segmentationId,
            options: {
              SeriesDescription: reportName || label || 'Research Derived Series',
            },
          });

          if (!generatedData || !generatedData.dataset) {
            throw new Error('Error during segmentation generation');
          }

          const { dataset: naturalizedReport } = generatedData;

          await selectedDataSourceConfig.store.dicom(naturalizedReport);

          // add the information for where we stored it to the instance as well
          naturalizedReport.wadoRoot = selectedDataSourceConfig.getConfig().wadoRoot;

          DicomMetadataStore.addInstances([naturalizedReport], true);

          return naturalizedReport;
        } catch (error) {
          console.debug('Error storing segmentation:', error);
          throw error;
        }
      }
    },
    /**
     * Converts segmentations into RTSS for download.
     * This sample function retrieves all segentations and passes to
     * cornerstone tool adapter to convert to DICOM RTSS format. It then
     * converts dataset to downloadable blob.
     *
     */
    downloadRTSS: ({ segmentationId }) => {
      const segmentations = segmentationService.getSegmentation(segmentationId);
      const vtkUtils = {
        vtkImageMarchingSquares,
        vtkDataArray,
        vtkImageData,
      };

      const RTSS = generateRTSSFromSegmentations(
        segmentations,
        classes.MetadataProvider,
        DicomMetadataStore,
        cache,
        cornerstoneToolsEnums,
        vtkUtils
      );

      try {
        const reportBlob = datasetToBlob(RTSS);

        //Create a URL for the binary.
        const objectUrl = URL.createObjectURL(reportBlob);
        window.location.assign(objectUrl);
      } catch (e) {
        console.warn(e);
      }
    },
    setBrushSize: ({ value, toolNames }) => {
      const brushSize = Number(value);

      toolGroupService.getToolGroupIds()?.forEach(toolGroupId => {
        if (toolNames?.length === 0) {
          segmentationUtils.setBrushSizeForToolGroup(toolGroupId, brushSize);
        } else {
          toolNames?.forEach(toolName => {
            segmentationUtils.setBrushSizeForToolGroup(toolGroupId, brushSize, toolName);
          });
        }
      });
    },
    setThresholdRange: ({
      value,
      toolNames = [
        'ThresholdCircularBrush',
        'ThresholdSphereBrush',
        'ThresholdCircularBrushDynamic',
        'ThresholdSphereBrushDynamic',
      ],
    }) => {
      const toolGroupIds = toolGroupService.getToolGroupIds();
      if (!toolGroupIds?.length) {
        return;
      }

      for (const toolGroupId of toolGroupIds) {
        const toolGroup = toolGroupService.getToolGroup(toolGroupId);
        toolNames?.forEach(toolName => {
          toolGroup.setToolConfiguration(toolName, {
            threshold: {
              range: value,
            },
          });
        });
      }
    },
  };

  const definitions = {
    /**
     * Obsolete?
     */
    loadSegmentationDisplaySetsForViewport: {
      commandFn: actions.loadSegmentationDisplaySetsForViewport,
    },
    /**
     * Obsolete?
     */
    loadSegmentationsForViewport: {
      commandFn: actions.loadSegmentationsForViewport,
    },

    generateSegmentation: {
      commandFn: actions.generateSegmentation,
    },
    downloadSegmentation: {
      commandFn: actions.downloadSegmentation,
    },
    downloadSegmentationPdf: {
      commandFn: actions.downloadSegmentationPdf,
    },
    storeSegmentation: {
      commandFn: actions.storeSegmentation,
    },
    downloadRTSS: {
      commandFn: actions.downloadRTSS,
    },
    setBrushSize: {
      commandFn: actions.setBrushSize,
    },
    setThresholdRange: {
      commandFn: actions.setThresholdRange,
    },
  };

  return {
    actions,
    definitions,
    defaultContext: 'SEGMENTATION',
  };
};

export default commandsModule;
