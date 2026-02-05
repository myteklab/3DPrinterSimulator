/**
 * Main application controller
 */

let simulator = null;
let parser = null;
let generator = null;
let slicer = null;
let currentGCode = null;
let gcodeLines = [];
let stepMode = false;
let currentSTLFile = null;
let lastGCodeUpdate = 0; // Throttle G-code updates

// Multi-STL management
let loadedModels = []; // Array of {id, name, file, mesh, previewMesh, position, rotation, scale, boundingBox, url}
let selectedModelId = null;
let modelIdCounter = 0;
let gizmoManager = null; // Babylon.js gizmo manager for interactive transformations

// Project management
let currentProjectId = null;
let hasUnsavedChanges = false;
let isPrintComplete = false; // Track if print finished for save/restore

// Initialize when page loads
document.addEventListener('DOMContentLoaded', () => {
    const canvas = document.getElementById('renderCanvas');
    simulator = new PrinterSimulator(canvas);
    parser = new GCodeParser();
    generator = new GCodeGenerator();
    slicer = new STLSlicer();

    // Set up event listeners
    setupEventListeners();

    // Set up progress callback
    simulator.onProgress = updateProgress;
    simulator.onComplete = onPrintComplete;

    // Set up click-to-select on canvas
    canvas.addEventListener('click', handleCanvasClick);

    // Initialize gizmo manager (wait for scene to be ready)
    setTimeout(() => {
        if (simulator && simulator.scene) {
            initializeGizmos();
        }
    }, 100);

    // Check for URL parameters to auto-load STL
    checkURLParameters();

    console.log('3D Printer Simulator initialized');
});

/**
 * Show status toast notification
 */
function showToast(message, type = 'info', duration = 0) {
    const toast = document.getElementById('status-toast');
    if (!toast) return;

    // Set content with optional spinner
    if (type === 'loading') {
        toast.innerHTML = `<div class="spinner"></div>${message}`;
        toast.className = 'status-toast';
    } else {
        toast.innerHTML = message;
        toast.className = `status-toast ${type}`;
    }

    // Show toast
    toast.classList.remove('hidden');

    // Auto-hide if duration specified
    if (duration > 0) {
        setTimeout(() => {
            toast.classList.add('hidden');
        }, duration);
    }
}

/**
 * Hide status toast
 */
function hideToast() {
    const toast = document.getElementById('status-toast');
    if (toast) toast.classList.add('hidden');
}

/**
 * Helper to safely update slice button state
 */
function updateSliceButton(disabled, text) {
    const sliceBtn = document.getElementById('slice-btn');
    if (sliceBtn) {
        sliceBtn.disabled = disabled;
        sliceBtn.textContent = text;
    }
}

/**
 * Helper to update slice status text
 */
function updateSliceStatus(text) {
    const statusEl = document.getElementById('slice-status');
    if (statusEl) {
        statusEl.textContent = text;
    }
}

/**
 * Set up UI event listeners
 */
function setupEventListeners() {
    // File upload
    document.getElementById('stl-file').addEventListener('change', handleSTLUpload);
    const gcodeFileEl = document.getElementById('gcode-file');
    if (gcodeFileEl) gcodeFileEl.addEventListener('change', handleFileUpload);
    const loadSampleEl = document.getElementById('load-sample');
    if (loadSampleEl) loadSampleEl.addEventListener('click', loadSampleGCode);
    document.getElementById('load-url-btn').addEventListener('click', loadSTLFromURL);

    // Slice settings (with null checks for elements that may be in dock instead)
    const qualityPreset = document.getElementById('quality-preset');
    if (qualityPreset) {
        qualityPreset.addEventListener('change', (e) => {
            handleQualityPreset(e);
            markDirty();
        });
    }
    const layerHeight = document.getElementById('layer-height');
    if (layerHeight) {
        layerHeight.addEventListener('input', (e) => {
            document.getElementById('layer-height-value').textContent = parseFloat(e.target.value).toFixed(2);
            markDirty();
        });
    }
    const infillDensity = document.getElementById('infill-density');
    if (infillDensity) {
        infillDensity.addEventListener('input', (e) => {
            document.getElementById('infill-density-value').textContent = e.target.value;
            markDirty();
        });
    }
    const topBottomLayers = document.getElementById('top-bottom-layers');
    if (topBottomLayers) {
        topBottomLayers.addEventListener('input', (e) => {
            document.getElementById('top-bottom-layers-value').textContent = e.target.value;
            markDirty();
        });
    }
    const sliceBtn = document.getElementById('slice-btn');
    if (sliceBtn) {
        sliceBtn.addEventListener('click', sliceSTL);
    }
    const generateGcodeBtn = document.getElementById('generate-gcode');
    if (generateGcodeBtn) {
        generateGcodeBtn.addEventListener('click', generateGCode);
    }

    // Playback controls (now in bottom dock)
    const playBtn = document.getElementById('play-btn');
    const pauseBtn = document.getElementById('pause-btn');
    const resetBtn = document.getElementById('reset-btn');
    const exportBtn = document.getElementById('export-stl-btn');

    if (playBtn) playBtn.addEventListener('click', playSimulation);
    if (pauseBtn) pauseBtn.addEventListener('click', pauseSimulation);
    if (resetBtn) resetBtn.addEventListener('click', resetSimulation);
    if (exportBtn) exportBtn.addEventListener('click', exportSTL);

    // Speed control (now in bottom dock)
    const speedSlider = document.getElementById('speed-slider');
    if (speedSlider) {
        speedSlider.addEventListener('input', (e) => {
            const speed = parseFloat(e.target.value);
            // Show more decimals for slow speeds
            const decimals = speed < 1 ? 2 : (speed < 10 ? 1 : 0);
            const speedValueEl = document.getElementById('speed-value');
            if (speedValueEl) speedValueEl.textContent = speed.toFixed(decimals);
            if (simulator) {
                simulator.setSpeed(speed);
            }
        });
    }

    // View options
    document.getElementById('show-printhead').addEventListener('change', (e) => {
        simulator.togglePrintHead(e.target.checked);
    });
    document.getElementById('show-bed').addEventListener('change', (e) => {
        simulator.toggleBuildPlate(e.target.checked);
    });
    document.getElementById('use-cylinders').addEventListener('change', (e) => {
        simulator.useLineRendering = !e.target.checked;
        console.log(`Rendering mode: ${e.target.checked ? 'Cylinders (3D)' : 'Lines (Fast)'}`);
    });
    document.getElementById('rainbow-mode').addEventListener('change', (e) => {
        simulator.rainbowMode = e.target.checked;
        console.log(`Rainbow mode: ${e.target.checked ? 'On' : 'Off'}`);
    });

    // Appearance controls (with null checks - some may be in dock only)
    const lineThicknessEl = document.getElementById('line-thickness');
    if (lineThicknessEl) {
        lineThicknessEl.addEventListener('input', (e) => {
            const thickness = parseFloat(e.target.value);
            const valueEl = document.getElementById('line-thickness-value');
            if (valueEl) valueEl.textContent = thickness.toFixed(1);
            simulator.lineThickness = thickness;
            console.log(`Line thickness: ${thickness}`);
        });
    }

    const filamentColorEl = document.getElementById('filament-color');
    if (filamentColorEl) {
        filamentColorEl.addEventListener('input', (e) => {
            const hex = e.target.value;
            simulator.setFilamentColor(hex);
            console.log(`Filament color: ${hex}`);
        });
    }

    const colorPresetsEl = document.getElementById('color-presets');
    if (colorPresetsEl) {
        colorPresetsEl.addEventListener('change', (e) => {
            const hex = e.target.value;
            const colorInput = document.getElementById('filament-color');
            if (colorInput) colorInput.value = hex;
            simulator.setFilamentColor(hex);
            console.log(`Color preset selected: ${hex}`);
        });
    }

    // Temperature presets for different filament types
    const filamentPresets = {
        pla: { hotend: 200, bed: 60 },
        petg: { hotend: 235, bed: 80 },
        abs: { hotend: 240, bed: 100 },
        tpu: { hotend: 220, bed: 60 },
        nylon: { hotend: 250, bed: 80 }
    };

    // Function to update temperatures based on filament type
    function updateFilamentTemperatures(type) {
        const temps = filamentPresets[type];
        if (temps) {
            simulator.targetHotendTemp = temps.hotend;
            simulator.targetBedTemp = temps.bed;
            console.log(`Filament type changed to ${type.toUpperCase()}: Hotend=${temps.hotend}°C, Bed=${temps.bed}°C`);
        }
    }

    // Temperature controls (with null checks - may be in dock only)
    const filamentTypeEl = document.getElementById('filament-type') || document.getElementById('dock-filament-type');
    if (filamentTypeEl) {
        // Set initial temperatures based on default selection
        updateFilamentTemperatures(filamentTypeEl.value);

        filamentTypeEl.addEventListener('change', (e) => {
            const type = e.target.value;
            const customTemps = document.getElementById('custom-temps');

            if (type === 'custom') {
                if (customTemps) customTemps.style.display = 'block';
            } else {
                if (customTemps) customTemps.style.display = 'none';
                updateFilamentTemperatures(type);
            }
        });
    }

    const hotendTempEl = document.getElementById('hotend-temp');
    if (hotendTempEl) {
        hotendTempEl.addEventListener('input', (e) => {
            const temp = parseInt(e.target.value);
            const valueEl = document.getElementById('hotend-temp-value');
            if (valueEl) valueEl.textContent = temp;
            simulator.targetHotendTemp = temp;
        });
    }

    const bedTempEl = document.getElementById('bed-temp');
    if (bedTempEl) {
        bedTempEl.addEventListener('input', (e) => {
            const temp = parseInt(e.target.value);
            const valueEl = document.getElementById('bed-temp-value');
            if (valueEl) valueEl.textContent = temp;
            simulator.targetBedTemp = temp;
        });
    }

    // G-code panel toggle
    const toggleGcodePanelBtn = document.getElementById('toggle-gcode-panel');
    if (toggleGcodePanelBtn) {
        toggleGcodePanelBtn.addEventListener('click', toggleGCodePanel);
    }

    // Quick print mode toggle
    const quickPrintCheckbox = document.getElementById('quick-print');
    if (quickPrintCheckbox) {
        quickPrintCheckbox.addEventListener('change', (e) => {
            const isQuickPrint = e.target.checked;
            const speedSlider = document.getElementById('speed-slider');
            const stepModeEl = document.getElementById('step-mode');
            const stepBackBtn = document.getElementById('step-back-btn');
            const stepForwardBtn = document.getElementById('step-forward-btn');

            // Disable animation controls when quick print is enabled
            if (speedSlider) speedSlider.disabled = isQuickPrint;
            if (stepModeEl) stepModeEl.disabled = isQuickPrint;

            if (isQuickPrint) {
                if (stepModeEl) stepModeEl.checked = false;
                if (stepBackBtn) stepBackBtn.disabled = true;
                if (stepForwardBtn) stepForwardBtn.disabled = true;
            }
        });
    }

    // Step mode (with null checks - may only exist in Learning Mode)
    const stepModeCheckbox = document.getElementById('step-mode');
    if (stepModeCheckbox) {
        stepModeCheckbox.addEventListener('change', (e) => {
            stepMode = e.target.checked;
            updateStepControls();
        });
    }
    const stepForwardBtn = document.getElementById('step-forward-btn');
    if (stepForwardBtn) {
        stepForwardBtn.addEventListener('click', stepForward);
    }
    const stepBackBtn = document.getElementById('step-back-btn');
    if (stepBackBtn) {
        stepBackBtn.addEventListener('click', stepBack);
    }
}

/**
 * Toggle G-code panel visibility
 */
function toggleGCodePanel() {
    const panel = document.getElementById('gcode-panel');
    const btn = document.getElementById('toggle-gcode-panel');
    panel.classList.toggle('collapsed');
    btn.textContent = panel.classList.contains('collapsed') ? '▲ Show' : '▼ Hide';
}

/**
 * Update step control button states
 */
function updateStepControls() {
    const hasGCode = simulator.commands && simulator.commands.length > 0;
    const stepForwardBtn = document.getElementById('step-forward-btn');
    const stepBackBtn = document.getElementById('step-back-btn');
    if (stepForwardBtn) {
        stepForwardBtn.disabled = !stepMode || !hasGCode;
    }
    if (stepBackBtn) {
        stepBackBtn.disabled = !stepMode || !hasGCode || simulator.currentCommandIndex === 0;
    }
}

/**
 * Step forward one command
 */
function stepForward() {
    if (!stepMode || !simulator.commands || simulator.currentCommandIndex >= simulator.commands.length) {
        return;
    }

    simulator.pause();
    simulator.executeCommand(simulator.commands[simulator.currentCommandIndex]);
    simulator.currentCommandIndex++;

    // Update progress
    const cmd = simulator.commands[simulator.currentCommandIndex - 1] || {};
    updateProgress({
        commandIndex: simulator.currentCommandIndex,
        totalCommands: simulator.commands.length,
        layer: cmd.layer || 0,
        position: cmd.to || { x: 0, y: 0, z: 0 },
        extruding: cmd.extruding || false
    });

    updateGCodeHighlight(simulator.currentCommandIndex - 1);
    updateStepControls();
}

/**
 * Step back one command
 */
function stepBack() {
    if (!stepMode || simulator.currentCommandIndex <= 0) {
        return;
    }

    // Reset and replay up to one step before
    const targetIndex = simulator.currentCommandIndex - 1;
    simulator.reset();

    for (let i = 0; i < targetIndex; i++) {
        simulator.executeCommand(simulator.commands[i]);
    }

    simulator.currentCommandIndex = targetIndex;

    // Update progress
    const cmd = simulator.commands[simulator.currentCommandIndex - 1] || {};
    updateProgress({
        commandIndex: simulator.currentCommandIndex,
        totalCommands: simulator.commands.length,
        layer: cmd.layer || 0,
        position: cmd.to || { x: 0, y: 0, z: 0 },
        extruding: cmd.extruding || false
    });

    updateGCodeHighlight(simulator.currentCommandIndex - 1);
    updateStepControls();
}

/**
 * Handle quality preset selection
 */
function handleQualityPreset() {
    const preset = document.getElementById('quality-preset').value;

    switch (preset) {
        case 'fast':
            simulator.useLineRendering = true;
            simulator.setSimplificationLevel(10.0); // Skip 90% of segments
            simulator.setLayerMergeInterval(1);
            document.getElementById('layer-height').value = 0.4;
            document.getElementById('layer-height-value').textContent = '0.40';
            break;
        case 'normal':
            simulator.useLineRendering = true;
            simulator.setSimplificationLevel(4.0); // Skip 75% of segments
            simulator.setLayerMergeInterval(2);
            document.getElementById('layer-height').value = 0.2;
            document.getElementById('layer-height-value').textContent = '0.20';
            break;
        case 'detailed':
            simulator.useLineRendering = true;
            simulator.setSimplificationLevel(2.0); // Skip 50% of segments
            simulator.setLayerMergeInterval(3);
            document.getElementById('layer-height').value = 0.15;
            document.getElementById('layer-height-value').textContent = '0.15';
            break;
    }

    console.log(`Quality preset: ${preset} (line rendering: ${simulator.useLineRendering})`);
}

/**
 * Handle STL file upload - Add model to build plate
 */
async function handleSTLUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    try {
        // Parse STL to get mesh data
        const tempSlicer = new STLSlicer();
        await tempSlicer.parseSTL(file);
        const bbox = tempSlicer.getBoundingBox();
        const triangleCount = tempSlicer.mesh.length;

        // Create model object
        const modelId = ++modelIdCounter;

        // Check if model needs to be laid flat (if it's taller in Y than Z, rotate it)
        // Most STLs come oriented standing up and need to be rotated to lay flat for printing
        const needsRotation = bbox.size.y > bbox.size.z;

        const model = {
            id: modelId,
            name: file.name,
            file: file,
            mesh: tempSlicer.mesh,
            previewMesh: null,
            // Position so bottom of model sits on build plate (Z=0)
            position: { x: 0, y: 0, z: 0 },
            // Rotate -90° around X axis to lay flat if needed
            rotation: needsRotation ? { x: -90, y: 0, z: 0 } : { x: 0, y: 0, z: 0 },
            scale: { x: 1, y: 1, z: 1 },
            boundingBox: bbox,
            triangleCount: triangleCount
        };

        // Add to loaded models
        loadedModels.push(model);

        // Create ghost preview mesh
        createGhostPreview(model);

        // Automatically drop to build plate so model sits correctly
        // Wait a frame for the mesh to be fully created
        setTimeout(() => {
            const tempSelectedId = selectedModelId;
            selectedModelId = modelId; // Temporarily select this model
            dropToBuildPlate();
            selectedModelId = tempSelectedId; // Restore previous selection
        }, 50);

        // Update UI
        updateModelList();
        selectModel(modelId);

        // Enable slice button
        updateSliceButton(false, '🔪 Slice');
        updateSliceStatus(`${loadedModels.length} model(s) ready to slice`);

        console.log(`Model added: ${file.name} (${triangleCount} triangles)`);

        // Mark as changed
        markDirty();

        // Clear file input so same file can be loaded again
        event.target.value = '';
    } catch (error) {
        console.error('Error loading STL:', error);
        showToast(`Error loading STL: ${error.message}`, 'error', 4000);
    }
}

/**
 * Load STL from URL button click
 */
async function loadSTLFromURL() {
    const urlInput = document.getElementById('stl-url');
    const url = urlInput.value.trim();

    if (!url) {
        showToast('Please enter a URL to an STL file', 'error', 3000);
        return;
    }

    await loadSTLFromURLCore(url);
}

/**
 * Check URL parameters for auto-loading STL
 */
function checkURLParameters() {
    const urlParams = new URLSearchParams(window.location.search);
    const stlUrl = urlParams.get('stl');

    if (stlUrl) {
        console.log('Auto-loading STL from URL parameter:', stlUrl);
        // Wait a bit for scene to be fully initialized
        setTimeout(() => {
            loadSTLFromURLCore(stlUrl);
        }, 500);
    }
}

/**
 * Core function to load STL from URL
 */
async function loadSTLFromURLCore(url) {
    const loadBtn = document.getElementById('load-url-btn');
    const originalText = loadBtn.textContent;

    try {
        loadBtn.disabled = true;
        loadBtn.textContent = '⏳ Loading...';

        console.log('Fetching STL from URL:', url);

        // Fetch the STL file
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`HTTP error ${response.status}: ${response.statusText}`);
        }

        // Get filename from URL or Content-Disposition header
        let filename = 'model.stl';
        const contentDisposition = response.headers.get('Content-Disposition');
        if (contentDisposition) {
            const filenameMatch = contentDisposition.match(/filename="?(.+)"?/);
            if (filenameMatch) {
                filename = filenameMatch[1];
            }
        } else {
            // Extract from URL path
            const urlPath = new URL(url).pathname;
            const urlFilename = urlPath.substring(urlPath.lastIndexOf('/') + 1);
            if (urlFilename) {
                filename = decodeURIComponent(urlFilename);
            }
        }

        // Convert response to blob then to File object
        const blob = await response.blob();
        const file = new File([blob], filename, { type: 'model/stl' });

        // Parse STL to get mesh data
        const tempSlicer = new STLSlicer();
        await tempSlicer.parseSTL(file);
        const bbox = tempSlicer.getBoundingBox();
        const triangleCount = tempSlicer.mesh.length;

        // Create model object
        const modelId = ++modelIdCounter;

        // Check if model needs to be laid flat (if it's taller in Y than Z, rotate it)
        const needsRotation = bbox.size.y > bbox.size.z;

        const model = {
            id: modelId,
            name: filename,
            file: file,
            mesh: tempSlicer.mesh,
            previewMesh: null,
            position: { x: 0, y: 0, z: 0 },
            rotation: needsRotation ? { x: -90, y: 0, z: 0 } : { x: 0, y: 0, z: 0 },
            scale: { x: 1, y: 1, z: 1 },
            boundingBox: bbox,
            triangleCount: triangleCount,
            url: url  // Store URL so we can save/reload
        };

        // Add to loaded models
        loadedModels.push(model);

        // Create ghost preview mesh
        createGhostPreview(model);

        // Automatically drop to build plate
        setTimeout(() => {
            const tempSelectedId = selectedModelId;
            selectedModelId = modelId;
            dropToBuildPlate();
            selectedModelId = tempSelectedId;
        }, 50);

        // Update UI
        updateModelList();
        selectModel(modelId);

        // Enable slice button
        updateSliceButton(false, '🔪 Slice');
        updateSliceStatus(`${loadedModels.length} model(s) ready to slice`);

        console.log(`Model loaded from URL: ${filename} (${triangleCount} triangles)`);

        // Mark as changed
        markDirty();

        // Clear URL input
        document.getElementById('stl-url').value = '';

    } catch (error) {
        console.error('Error loading STL from URL:', error);
        showToast(`Error loading STL from URL: ${error.message}`, 'error', 4000);
    } finally {
        loadBtn.disabled = false;
        loadBtn.textContent = originalText;
    }
}

/**
 * Slice all models on build plate into G-code
 */
async function sliceSTL() {
    if (loadedModels.length === 0) {
        showToast('Please load at least one STL model first!', 'error', 3000);
        return;
    }

    updateSliceButton(true, '⏳ Slicing...');
    updateSliceStatus('Processing models...');
    showToast('Slicing models...', 'loading');

    // Small delay to allow UI to update before heavy computation
    await new Promise(resolve => setTimeout(resolve, 50));

    try {
        // Get settings from dock (fallback to any available element)
        const layerHeightEl = document.getElementById('dock-layer-height') || document.getElementById('layer-height');
        const shellLayersEl = document.getElementById('dock-shell-layers') || document.getElementById('top-bottom-layers');
        const nozzleEl = document.getElementById('dock-line-thickness') || document.getElementById('line-thickness');
        const infillPatternEl = document.getElementById('dock-infill-pattern') || document.getElementById('infill-pattern');
        const infillDensityEl = document.getElementById('dock-infill-density') || document.getElementById('infill-density');

        const layerHeight = layerHeightEl ? parseFloat(layerHeightEl.value) : 0.2;
        const topBottomLayers = shellLayersEl ? parseInt(shellLayersEl.value) : 3;
        const nozzleDiameter = nozzleEl ? parseFloat(nozzleEl.value) : 0.4;
        const infillPattern = infillPatternEl ? infillPatternEl.value : 'grid';
        const infillDensity = infillDensityEl ? parseInt(infillDensityEl.value) : 20;

        console.log(`Slicing ${loadedModels.length} model(s)...`);

        // NEW APPROACH: Slice each model separately first, then combine layers
        // This allows us to correctly identify top/bottom layers for each model
        const modelSlices = [];

        for (const model of loadedModels) {
            console.log(`Processing model: ${model.name}`);

            // Get world space vertices directly from Babylon mesh
            if (!model.previewMesh) {
                console.warn(`  Model ${model.name} has no preview mesh!`);
                continue;
            }

            model.previewMesh.computeWorldMatrix(true);
            const positions = model.previewMesh.getVerticesData(BABYLON.VertexBuffer.PositionKind);
            const indices = model.previewMesh.getIndices();
            const worldMatrix = model.previewMesh.getWorldMatrix();

            console.log(`  Using Babylon world space vertices (${indices.length/3} triangles)`);

            // Convert Babylon mesh to our triangle format
            const modelMesh = [];
            for (let i = 0; i < indices.length; i += 3) {
                const i1 = indices[i] * 3;
                const i2 = indices[i + 1] * 3;
                const i3 = indices[i + 2] * 3;

                // Get vertices in local space
                const v1Local = new BABYLON.Vector3(positions[i1], positions[i1+1], positions[i1+2]);
                const v2Local = new BABYLON.Vector3(positions[i2], positions[i2+1], positions[i2+2]);
                const v3Local = new BABYLON.Vector3(positions[i3], positions[i3+1], positions[i3+2]);

                // Transform to world space
                const v1World = BABYLON.Vector3.TransformCoordinates(v1Local, worldMatrix);
                const v2World = BABYLON.Vector3.TransformCoordinates(v2Local, worldMatrix);
                const v3World = BABYLON.Vector3.TransformCoordinates(v3Local, worldMatrix);

                // Convert to slicer format: swap Y and Z (Babylon Y → slicer Z)
                modelMesh.push({
                    v1: { x: v1World.x, y: v1World.z, z: v1World.y },
                    v2: { x: v2World.x, y: v2World.z, z: v2World.y },
                    v3: { x: v3World.x, y: v3World.z, z: v3World.y }
                });
            }

            // Slice this individual model
            const modelSlicer = new STLSlicer();
            modelSlicer.mesh = modelMesh;
            modelSlicer.layerHeight = layerHeight;
            modelSlicer.topBottomLayers = topBottomLayers;
            modelSlicer.nozzleDiameter = nozzleDiameter;

            const modelLayers = modelSlicer.sliceMesh();
            const modelSequences = modelSlicer.analyzeLayerSequences(modelLayers);

            console.log(`  Model ${model.name}: ${modelLayers.length} layers, height ${(modelLayers.length * layerHeight).toFixed(2)}mm`);

            modelSlices.push({
                name: model.name,
                mesh: modelMesh,
                layers: modelLayers,
                sequences: modelSequences
            });
        }

        // Now combine all models' meshes for the actual slicing
        const combinedMesh = [];
        for (const modelSlice of modelSlices) {
            combinedMesh.push(...modelSlice.mesh);
        }

        console.log(`Combined mesh has ${combinedMesh.length} triangles`);

        // Validate that all vertices are above or on the build plate (Z >= 0)
        let minZ = Infinity;
        let maxZ = -Infinity;

        for (const triangle of combinedMesh) {
            for (const vertex of [triangle.v1, triangle.v2, triangle.v3]) {
                if (vertex.z < minZ) minZ = vertex.z;
                if (vertex.z > maxZ) maxZ = vertex.z;
            }
        }

        console.log(`Combined mesh Z range: ${minZ.toFixed(2)} to ${maxZ.toFixed(2)}`);

        if (minZ < -0.1) { // Allow tiny tolerance for floating point
            showToast(`Model extends below build plate (${minZ.toFixed(2)}mm). Use "Drop to Build Plate" to fix.`, 'error', 4000);
            sliceBtn.disabled = false;
            sliceBtn.textContent = `🔪 Slice`;
            return;
        }

        if (minZ > 0.1) {
            const proceed = confirm(`Warning: Model is floating ${minZ.toFixed(2)}mm above build plate.\n\nThis will waste filament printing air. Continue anyway?`);
            if (!proceed) {
                sliceBtn.disabled = false;
                sliceBtn.textContent = `🔪 Slice`;
                return;
            }
        }

        // Create a temporary slicer with the combined mesh
        const tempSlicer = new STLSlicer();
        tempSlicer.mesh = combinedMesh;
        tempSlicer.layerHeight = layerHeight;
        tempSlicer.topBottomLayers = topBottomLayers;
        tempSlicer.nozzleDiameter = nozzleDiameter;

        // Slice combined mesh
        console.log('Slicing combined mesh...');
        const layers = tempSlicer.sliceMesh();

        if (!layers || layers.length === 0) {
            throw new Error('Failed to slice mesh - no layers generated');
        }

        // Build custom sequences by merging individual model sequences
        console.log('\n=== Building per-model top/bottom sequences ===');
        const mergedSequences = new Array(layers.length).fill(null).map(() => ({
            isBottom: false,
            isTop: false
        }));

        for (const modelSlice of modelSlices) {
            console.log(`Model ${modelSlice.name}: ${modelSlice.layers.length} layers`);

            // Map this model's sequences to the combined layer array
            for (let i = 0; i < modelSlice.sequences.length; i++) {
                const layerZ = modelSlice.layers[i].z;

                // Find corresponding layer in combined array
                for (let j = 0; j < layers.length; j++) {
                    if (Math.abs(layers[j].z - layerZ) < 0.001) {
                        // This is the same layer - merge the sequences
                        if (modelSlice.sequences[i].isBottom) {
                            mergedSequences[j].isBottom = true;
                        }
                        if (modelSlice.sequences[i].isTop) {
                            mergedSequences[j].isTop = true;
                            console.log(`  Layer ${j} (Z=${layerZ.toFixed(2)}): Marked as TOP for ${modelSlice.name}`);
                        }
                        break;
                    }
                }
            }
        }

        console.log('=== Per-model sequences complete ===\n');

        // Generate G-code with custom sequences
        console.log('Generating G-code with per-model top/bottom layers...');
        const gcodeText = tempSlicer.generateGCodeWithSequences(layers, infillPattern, infillDensity, mergedSequences);

        // Load into simulator
        loadGCode(gcodeText);

        updateSliceButton(false, '✅ Sliced!');
        updateSliceStatus(`Generated ${layers.length} layers`);
        showToast(`✅ Slicing complete! ${layers.length} layers generated`, 'success', 3000);
        setTimeout(() => {
            updateSliceButton(false, '🔪 Slice');
            updateSliceStatus(`${loadedModels.length} model(s) ready to slice`);
        }, 2000);

        console.log(`Slicing complete! Generated ${layers.length} layers from ${loadedModels.length} model(s)`);

        // Hide ghost previews and detach gizmos after slicing
        loadedModels.forEach(model => {
            if (model.previewMesh) {
                model.previewMesh.setEnabled(false);
                model.previewMesh.isPickable = false; // Disable picking during print
            }
        });

        // Detach gizmos during print
        if (gizmoManager) {
            gizmoManager.attachToMesh(null);
        }

    } catch (error) {
        console.error('Slicing error:', error);
        showToast(`Slicing failed: ${error.message}`, 'error', 5000);
        updateSliceButton(false, '🔪 Slice');
        updateSliceStatus('Slicing failed - check console');
    }
}

/**
 * Transform a vertex by model's scale, rotation, and position
 * Uses the EXACT same matrix as Babylon.js
 */
function transformVertex(vertex, model) {
    const DEBUG = (vertex.x === 100 && vertex.y === 100 && vertex.z === 0); // Debug the platform vertex

    // Step 1: Apply scaling
    let x = vertex.x * model.scale.x;
    let y = vertex.y * model.scale.y;
    let z = vertex.z * model.scale.z;

    // Step 2: Apply rotation using Babylon.js YXZ order
    const rotX = model.rotation.x * Math.PI / 180;
    const rotY = model.rotation.y * Math.PI / 180;
    const rotZ = model.rotation.z * Math.PI / 180;

    const cX = Math.cos(rotX), sX = Math.sin(rotX);
    const cY = Math.cos(rotY), sY = Math.sin(rotY);
    const cZ = Math.cos(rotZ), sZ = Math.sin(rotZ);

    if (DEBUG) {
        console.log(`    transformVertex DEBUG: input (${vertex.x}, ${vertex.y}, ${vertex.z})`);
        console.log(`    rotX=${model.rotation.x}°, cX=${cX.toFixed(3)}, sX=${sX.toFixed(3)}`);
    }

    // Babylon.js rotation matrix (YXZ order)
    // This is the combined matrix from Y * X * Z rotations
    const m00 = cY * cZ + sY * sX * sZ;
    const m01 = cX * sZ;
    const m02 = cY * sX * sZ - sY * cZ;

    const m10 = sY * sX * cZ - cY * sZ;
    const m11 = cX * cZ;
    const m12 = sY * sZ + cY * sX * cZ;

    const m20 = sY * cX;
    const m21 = -sX;
    const m22 = cY * cX;

    if (DEBUG) {
        console.log(`    Matrix row 1: [${m00.toFixed(3)}, ${m01.toFixed(3)}, ${m02.toFixed(3)}]`);
        console.log(`    Matrix row 2: [${m10.toFixed(3)}, ${m11.toFixed(3)}, ${m12.toFixed(3)}]`);
        console.log(`    Matrix row 3: [${m20.toFixed(3)}, ${m21.toFixed(3)}, ${m22.toFixed(3)}]`);
    }

    // Apply rotation matrix
    const rotX_result = x * m00 + y * m01 + z * m02;
    const rotY_result = x * m10 + y * m11 + z * m12;
    const rotZ_result = x * m20 + y * m21 + z * m22;

    if (DEBUG) {
        console.log(`    After rotation: (${rotX_result.toFixed(2)}, ${rotY_result.toFixed(2)}, ${rotZ_result.toFixed(2)})`);
    }

    // Step 3: Apply translation and output
    // IMPORTANT: The slicer expects Z to be the height dimension!
    // After rotation, the height is in Y, so we need to swap Y and Z in the output
    const finalX = rotX_result + model.position.x;
    const finalY = rotY_result + model.position.z;  // Height after rotation + model height offset
    const finalZ = rotZ_result + model.position.y;  // Depth

    return {
        x: finalX,
        y: finalZ,  // Output Y = depth (was in rotZ after rotation)
        z: finalY   // Output Z = height (was in rotY after rotation) - THIS IS WHAT SLICER USES
    };
}

/**
 * Handle G-code file upload
 */
function handleFileUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
        const gcodeText = e.target.result;
        loadGCode(gcodeText);
    };
    reader.readAsText(file);
}

/**
 * Generate G-code with selected pattern and density
 */
function generateGCode() {
    const pattern = document.getElementById('infill-pattern').value;
    const density = parseInt(document.getElementById('infill-density').value);
    const topBottomLayers = parseInt(document.getElementById('top-bottom-layers').value);

    console.log(`Generating G-code: pattern=${pattern}, density=${density}%, topBottom=${topBottomLayers}`);

    // Generate G-code
    const gcodeText = generator.generateCube(20, 20, pattern, density, topBottomLayers);
    loadGCode(gcodeText);

    console.log(`Generated ${gcodeText.split('\n').length} lines of G-code`);
}

/**
 * Load sample G-code
 */
function loadSampleGCode() {
    // Simple sample: a small calibration cube
    const sampleGCode = `
; 3D Printer Simulator Sample G-code
; Simple Cube (20mm x 20mm x 20mm)
G28 ; Home all axes
M104 S200 ; Set hotend temperature
M140 S60 ; Set bed temperature
G1 Z0.2 F5000 ; Move to first layer height

; Layer 1
G1 X10 Y10 Z0.2 F3000
G1 X30 Y10 E5 F1500 ; Bottom edge
G1 X30 Y30 E10
G1 X10 Y30 E15
G1 X10 Y10 E20
G1 X11 Y11 E21 ; Inner perimeter
G1 X29 Y11 E26
G1 X29 Y29 E31
G1 X11 Y29 E36
G1 X11 Y11 E41

; Layer 2
G1 Z0.4 F5000
G1 X10 Y10 E42
G1 X30 Y10 E47 F1500
G1 X30 Y30 E52
G1 X10 Y30 E57
G1 X10 Y10 E62
G1 X11 Y11 E63
G1 X29 Y11 E68
G1 X29 Y29 E73
G1 X11 Y29 E78
G1 X11 Y11 E83

; Layer 3
G1 Z0.6 F5000
G1 X10 Y10 E84
G1 X30 Y10 E89 F1500
G1 X30 Y30 E94
G1 X10 Y30 E99
G1 X10 Y10 E104
G1 X11 Y11 E105
G1 X29 Y11 E110
G1 X29 Y29 E115
G1 X11 Y29 E120
G1 X11 Y11 E125

; Layer 4
G1 Z0.8 F5000
G1 X10 Y10 E126
G1 X30 Y10 E131 F1500
G1 X30 Y30 E136
G1 X10 Y30 E141
G1 X10 Y10 E146
G1 X11 Y11 E147
G1 X29 Y11 E152
G1 X29 Y29 E157
G1 X11 Y29 E162
G1 X11 Y11 E167

; Layer 5
G1 Z1.0 F5000
G1 X10 Y10 E168
G1 X30 Y10 E173 F1500
G1 X30 Y30 E178
G1 X10 Y30 E183
G1 X10 Y10 E188
G1 X11 Y11 E189
G1 X29 Y11 E194
G1 X29 Y29 E199
G1 X11 Y29 E204
G1 X11 Y11 E209

; Layer 6
G1 Z1.2 F5000
G1 X10 Y10 E210
G1 X30 Y10 E215 F1500
G1 X30 Y30 E220
G1 X10 Y30 E225
G1 X10 Y10 E230
G1 X11 Y11 E231
G1 X29 Y11 E236
G1 X29 Y29 E241
G1 X11 Y29 E246
G1 X11 Y11 E251

; Layer 7
G1 Z1.4 F5000
G1 X10 Y10 E252
G1 X30 Y10 E257 F1500
G1 X30 Y30 E262
G1 X10 Y30 E267
G1 X10 Y10 E272
G1 X11 Y11 E273
G1 X29 Y11 E278
G1 X29 Y29 E283
G1 X11 Y29 E288
G1 X11 Y11 E293

; Layer 8
G1 Z1.6 F5000
G1 X10 Y10 E294
G1 X30 Y10 E299 F1500
G1 X30 Y30 E304
G1 X10 Y30 E309
G1 X10 Y10 E314
G1 X11 Y11 E315
G1 X29 Y11 E320
G1 X29 Y29 E325
G1 X11 Y29 E330
G1 X11 Y11 E335

; Layer 9
G1 Z1.8 F5000
G1 X10 Y10 E336
G1 X30 Y10 E341 F1500
G1 X30 Y30 E346
G1 X10 Y30 E351
G1 X10 Y10 E356
G1 X11 Y11 E357
G1 X29 Y11 E362
G1 X29 Y29 E367
G1 X11 Y29 E372
G1 X11 Y11 E377

; Layer 10 (Top)
G1 Z2.0 F5000
G1 X10 Y10 E378
G1 X30 Y10 E383 F1500
G1 X30 Y30 E388
G1 X10 Y30 E393
G1 X10 Y10 E398
; Infill
G1 X15 Y15 E400
G1 X25 Y15 E405
G1 X25 Y25 E410
G1 X15 Y25 E415
G1 X15 Y15 E420

; End
G1 Z10 F5000
M104 S0 ; Turn off hotend
M140 S0 ; Turn off bed
`;

    loadGCode(sampleGCode);
}

/**
 * Load and parse G-code
 */
function loadGCode(gcodeText) {
    currentGCode = gcodeText;
    gcodeLines = gcodeText.split('\n');
    const commands = parser.parse(gcodeText);

    if (commands.length === 0) {
        showToast('No valid G-code commands found!', 'error', 3000);
        return;
    }

    simulator.loadCommands(commands);

    // Store totals for HUD updates
    simulator.totalLines = commands.length;
    simulator.totalLayers = parser.getLayerCount();

    // Update HUD with initial values
    updateHUD({
        layer: 0,
        totalLayers: parser.getLayerCount(),
        line: 0,
        totalLines: commands.length,
        x: 0, y: 0, z: 0,
        extruding: false,
        temp: simulator.currentHotendTemp || 0,
        bedTemp: simulator.currentBedTemp || 0,
        percent: 0
    });

    // Enable play button
    const playBtn = document.getElementById('play-btn');
    const resetBtn = document.getElementById('reset-btn');
    if (playBtn) playBtn.disabled = false;
    if (resetBtn) resetBtn.disabled = false;

    // Display G-code
    displayGCode(gcodeText);

    // Update step controls
    updateStepControls();

    console.log(`Loaded ${commands.length} commands, ${parser.getLayerCount()} layers`);
}

/**
 * Display G-code in viewer panel
 */
function displayGCode(gcodeText) {
    const display = document.getElementById('gcode-display');
    const dockDisplay = document.getElementById('dock-gcode-display');
    const lines = gcodeText.split('\n');

    let html = '';
    lines.forEach((line, index) => {
        const trimmed = line.trim();
        let cssClass = 'gcode-line';

        if (trimmed.startsWith(';')) {
            cssClass += ' gcode-comment';
        } else if (trimmed.startsWith('G0') || trimmed.startsWith('G1')) {
            cssClass += ' gcode-move';
        } else if (trimmed.startsWith('M104') || trimmed.startsWith('M109') || trimmed.startsWith('M140') || trimmed.startsWith('M190')) {
            cssClass += ' gcode-temp';
        }

        html += `<div class="${cssClass}" data-line="${index}">${index + 1}: ${line || ' '}</div>`;
    });

    if (display) display.innerHTML = html;
    if (dockDisplay) dockDisplay.innerHTML = html;
}

/**
 * Update G-code highlighting - shows context window around current line
 */
function updateGCodeHighlight(commandIndex) {
    const dockDisplay = document.getElementById('dock-gcode-display');
    if (!dockDisplay || !gcodeLines || gcodeLines.length === 0) return;

    // Get the actual line number from the command
    const currentLineNum = simulator.commands[commandIndex]?.line;
    if (currentLineNum === undefined) return;

    // Show 5 lines before and 10 lines after current line
    const contextBefore = 5;
    const contextAfter = 10;
    const startLine = Math.max(0, currentLineNum - contextBefore);
    const endLine = Math.min(gcodeLines.length - 1, currentLineNum + contextAfter);

    let html = '';

    // Show indicator if there are lines before
    if (startLine > 0) {
        html += `<div class="gcode-ellipsis">... ${startLine} lines above ...</div>`;
    }

    for (let i = startLine; i <= endLine; i++) {
        const line = gcodeLines[i] || '';
        const trimmed = line.trim();
        let cssClass = 'gcode-line';

        if (i === currentLineNum) {
            cssClass += ' current';
        } else if (i < currentLineNum) {
            cssClass += ' executed';
        }

        if (trimmed.startsWith(';')) {
            cssClass += ' gcode-comment';
        } else if (trimmed.startsWith('G0') || trimmed.startsWith('G1')) {
            cssClass += ' gcode-move';
        } else if (trimmed.startsWith('M104') || trimmed.startsWith('M109') || trimmed.startsWith('M140') || trimmed.startsWith('M190')) {
            cssClass += ' gcode-temp';
        }

        html += `<div class="${cssClass}">${i + 1}: ${line || ' '}</div>`;
    }

    // Show indicator if there are lines after
    if (endLine < gcodeLines.length - 1) {
        html += `<div class="gcode-ellipsis">... ${gcodeLines.length - 1 - endLine} lines below ...</div>`;
    }

    dockDisplay.innerHTML = html;
}

/**
 * Play simulation
 */
function playSimulation() {
    if (!simulator.commands || simulator.commands.length === 0) {
        showToast('Please load a G-code file first!', 'error', 3000);
        return;
    }

    const playBtn = document.getElementById('play-btn');
    const quickPrintEl = document.getElementById('quick-print');
    const quickPrintMode = quickPrintEl ? quickPrintEl.checked : false;

    if (quickPrintMode) {
        // Quick print mode - skip animation and heat-up
        playBtn.disabled = true;
        playBtn.innerHTML = '⚡ Quick Printing...';

        // Show print head briefly
        if (simulator.printHead) {
            simulator.printHead.setEnabled(true);
        }

        // Set temperatures instantly (no heat-up animation)
        simulator.currentHotendTemp = simulator.targetHotendTemp;
        simulator.currentBedTemp = simulator.targetBedTemp;
        document.getElementById('hud-temp').textContent = `${simulator.currentHotendTemp}°C`;
        document.getElementById('hud-bed-temp').textContent = `${simulator.currentBedTemp}°C`;

        // Use setTimeout to allow UI to update
        setTimeout(() => {
            simulator.quickPrint(() => {
                // Quick print complete
                playBtn.disabled = false;
                playBtn.innerHTML = '▶ Print';
                document.getElementById('pause-btn').disabled = true;
            });
        }, 100);
    } else {
        // Normal mode with heat-up and animation
        playBtn.disabled = true;
        playBtn.innerHTML = '🔥 Heating...';

        // Start heat-up simulation
        simulator.startHeatup(() => {
            // Heat-up complete, start printing
            playBtn.innerHTML = '▶ Print';
            simulator.play();
            document.getElementById('pause-btn').disabled = false;
        });
    }
}

/**
 * Pause simulation
 */
function pauseSimulation() {
    simulator.pause();
    const playBtn = document.getElementById('play-btn');
    playBtn.disabled = false;
    playBtn.innerHTML = '▶ Print';
    document.getElementById('pause-btn').disabled = true;
}

/**
 * Reset simulation
 */
function resetSimulation() {
    simulator.reset();
    isPrintComplete = false; // Reset print completion state

    const playBtn = document.getElementById('play-btn');
    if (playBtn) {
        playBtn.disabled = false;
        playBtn.innerHTML = '▶ Print';
    }
    const pauseBtn = document.getElementById('pause-btn');
    if (pauseBtn) pauseBtn.disabled = true;

    // Reset HUD display
    updateHUD({
        layer: 0,
        totalLayers: simulator.totalLayers || 0,
        line: 0,
        totalLines: simulator.totalLines || 0,
        x: 0, y: 0, z: 0,
        extruding: false,
        temp: simulator.currentHotendTemp || 0,
        bedTemp: simulator.currentBedTemp || 0,
        percent: 0
    });

    // Show ghost previews again and re-enable picking
    loadedModels.forEach(model => {
        if (model.previewMesh) {
            model.previewMesh.setEnabled(true);
            model.previewMesh.isPickable = true;
        }
    });

    // Re-attach gizmos to selected model if any
    if (selectedModelId && document.getElementById('show-gizmos').checked) {
        attachGizmosToModel(selectedModelId);
    }
}

/**
 * Update progress display
 */
function updateProgress(progress) {
    const percent = progress.commandIndex / progress.totalCommands * 100;

    // Update HUD with progress
    updateHUD({
        layer: progress.layer,
        totalLayers: simulator.totalLayers || 0,
        line: progress.commandIndex,
        totalLines: progress.totalCommands,
        x: progress.position.x,
        y: progress.position.y,
        z: progress.position.z,
        extruding: progress.extruding,
        retracting: progress.retracting,
        temp: simulator.currentHotendTemp || 0,
        bedTemp: simulator.currentBedTemp || 0,
        percent: percent
    });

    // Update G-code highlighting (only if live tracking is enabled)
    const liveTracking = document.getElementById('live-gcode-tracking');
    if (!stepMode && liveTracking && liveTracking.checked) {
        const now = Date.now();
        if (now - lastGCodeUpdate > 100) {
            updateGCodeHighlight(progress.commandIndex - 1);
            lastGCodeUpdate = now;
        }
    }
}

/**
 * Called when print completes
 */
function onPrintComplete() {
    const playBtn = document.getElementById('play-btn');
    const pauseBtn = document.getElementById('pause-btn');
    if (playBtn) playBtn.disabled = false;
    if (pauseBtn) pauseBtn.disabled = true;
    console.log('Print simulation complete!');

    // Mark print as complete for save/restore
    isPrintComplete = true;
    markUnsavedChanges();

    // Show completion toast
    showToast('Print simulation complete!', 'success');

    // Auto-save screenshot for preview (after a short delay for final render)
    setTimeout(() => {
        saveScreenshot();
    }, 500);
}

/**
 * Save screenshot of the current view for preview thumbnails
 */
async function saveScreenshot(showFeedback = false) {
    if (!simulator || !simulator.scene || !currentProjectId) {
        if (showFeedback) {
            showToast('Please save your project first', 'error');
        }
        return;
    }

    try {
        // Temporarily hide gizmos for clean screenshot
        let previousGizmoMesh = null;
        if (gizmoManager) {
            previousGizmoMesh = gizmoManager.attachedMesh;
            gizmoManager.attachToMesh(null);
        }

        // Capture screenshot using RenderTarget (more reliable than CreateScreenshotAsync)
        const screenshot = await BABYLON.Tools.CreateScreenshotUsingRenderTargetAsync(
            simulator.engine,
            simulator.camera,
            { width: 600, height: 400 },
            undefined,
            undefined,
            undefined,
            undefined,
            'screenshot.png'
        );

        // Restore gizmos if they were attached
        if (gizmoManager && previousGizmoMesh) {
            gizmoManager.attachToMesh(previousGizmoMesh);
        }

        // Send to server
        const response = await fetch('/beta/applications/3DPrinter/save_screenshot.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
                project_id: currentProjectId,
                image: screenshot
            })
        });

        if (response.ok) {
            console.log('Screenshot saved for preview');
            if (showFeedback) {
                showToast('Preview updated!', 'success');
            }
        } else {
            if (showFeedback) {
                showToast('Failed to save preview', 'error');
            }
        }
    } catch (e) {
        console.error('Failed to save screenshot:', e);
        if (showFeedback) {
            showToast('Failed to save preview', 'error');
        }
    }
}

/**
 * Show export format selection modal
 */
function exportSTL() {
    if (!simulator) {
        showToast('Simulator not initialized!', 'error', 3000);
        return;
    }

    // Set default filename based on first model name or timestamp
    const filenameInput = document.getElementById('export-filename');
    if (filenameInput) {
        let defaultName = 'model_' + Date.now();
        if (loadedModels && loadedModels.length > 0 && loadedModels[0].name) {
            // Use first model's name, cleaned up
            defaultName = loadedModels[0].name.replace(/\.[^/.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_');
        }
        filenameInput.value = defaultName;
    }

    // Show the modal
    const modal = document.getElementById('export-modal');
    modal.style.display = 'block';
}

/**
 * Close export modal
 */
function closeExportModal() {
    const modal = document.getElementById('export-modal');
    modal.style.display = 'none';
}

/**
 * Export the printed model in selected format (download to computer)
 */
function exportModel(format) {
    closeExportModal();

    if (!simulator) {
        showToast('Simulator not initialized!', 'error', 3000);
        return;
    }

    try {
        if (format === 'stl') {
            simulator.exportAsSTL();
        } else if (format === 'gltf') {
            simulator.exportAsGLTF();
        }
    } catch (error) {
        console.error('Export failed:', error);
        showToast('Failed to export model: ' + error.message, 'error', 4000);
    }
}

/**
 * Export the model to MyTekOS assets (user's files)
 */
async function exportToAssets(format) {
    if (!simulator) {
        showToast('Simulator not initialized!', 'error');
        return;
    }

    // Check if there are models to export
    if (typeof loadedModels === 'undefined' || loadedModels.length === 0) {
        showToast('No models on build plate to export!', 'error');
        return;
    }

    // Get asset name from input field
    const filenameInput = document.getElementById('export-filename');
    let name = filenameInput ? filenameInput.value.trim() : '';

    // If no name provided, use default
    if (!name) {
        name = 'model_' + Date.now();
    }

    // Sanitize filename (remove special characters)
    name = name.replace(/[^a-zA-Z0-9_-]/g, '_');

    closeExportModal();

    try {
        let fileData;
        let filename;
        let mimeType;

        if (format === 'stl') {
            // Generate STL data
            fileData = simulator.generateSTLData();
            if (!fileData) {
                showToast('Failed to generate STL data', 'error');
                return;
            }
            filename = name + '.stl';
            mimeType = 'model/stl';

            // Convert string to Blob
            fileData = new Blob([fileData], { type: 'text/plain' });
        } else if (format === 'glb') {
            // Generate GLB data using Babylon's exporter
            fileData = await generateGLBData();
            if (!fileData) {
                showToast('Failed to generate GLB data', 'error');
                return;
            }
            filename = name + '.glb';
            mimeType = 'model/gltf-binary';
        }

        // Upload to MyTekOS assets
        showToast('Uploading to files...', 'info');
        await uploadToAssets(fileData, filename, mimeType);

    } catch (error) {
        console.error('Export to assets failed:', error);
        showToast('Export failed: ' + error.message, 'error');
    }
}

/**
 * Generate GLB data for export to assets.
 * If a print has been completed (tube meshes exist), exports the printed
 * result including shells/infill. Otherwise exports the original STL models.
 */
async function generateGLBData() {
    if (!simulator || !simulator.scene) {
        return null;
    }

    // Prefer the printed result (tube meshes) over raw preview meshes
    const meshesToExport = [];
    let usingPrintedResult = false;

    // Check for printed tube mesh from finalQualityRender
    if (simulator.lineMesh) {
        meshesToExport.push(simulator.lineMesh);
        usingPrintedResult = true;
    }
    // Also include any frozen meshes (chunks frozen during printing)
    if (simulator.frozenMeshes && simulator.frozenMeshes.length > 0) {
        for (const mesh of simulator.frozenMeshes) {
            if (mesh) meshesToExport.push(mesh);
        }
        usingPrintedResult = true;
    }

    // Fall back to original preview meshes if no print has been done
    if (!usingPrintedResult) {
        for (const model of loadedModels) {
            if (model.previewMesh) {
                meshesToExport.push(model.previewMesh);
            }
        }
    }

    if (meshesToExport.length === 0) {
        return null;
    }

    // Create a material with the selected filament color for export
    const exportMaterial = new BABYLON.StandardMaterial("export_material", simulator.scene);
    exportMaterial.diffuseColor = simulator.filamentColor.clone();
    exportMaterial.specularColor = new BABYLON.Color3(0.2, 0.2, 0.2);
    exportMaterial.alpha = 1.0;

    // Temporarily replace materials with colored material for export
    const originalMaterials = [];
    const originalEnabled = [];
    for (const mesh of meshesToExport) {
        originalMaterials.push(mesh.material);
        originalEnabled.push(mesh.isEnabled());
        mesh.material = exportMaterial;
        mesh.setEnabled(true);
    }

    try {
        // Export using Babylon's GLTF exporter
        const result = await BABYLON.GLTF2Export.GLBAsync(simulator.scene, 'build_plate_models', {
            shouldExportNode: (node) => {
                return meshesToExport.includes(node);
            }
        });

        // Get the GLB blob from the result
        const glbBlob = result.glTFFiles['build_plate_models.glb'];
        return glbBlob;

    } finally {
        // Restore original materials and enabled state
        for (let i = 0; i < meshesToExport.length; i++) {
            meshesToExport[i].material = originalMaterials[i];
            meshesToExport[i].setEnabled(originalEnabled[i]);
        }
        exportMaterial.dispose();
    }
}

/**
 * Upload file to MyTekOS assets
 */
async function uploadToAssets(data, filename, mimeType) {
    // Get auth token from localStorage or cookie
    let token = null;

    // Try localStorage first (parent, current, top)
    try {
        token = window.parent.localStorage.getItem('auth_token');
    } catch (e) {}

    if (!token) {
        try {
            token = localStorage.getItem('auth_token');
        } catch (e) {}
    }

    if (!token) {
        try {
            token = window.top.localStorage.getItem('auth_token');
        } catch (e) {}
    }

    // Fall back to cookie named 'auth'
    if (!token) {
        const cookies = document.cookie.split(';');
        for (let cookie of cookies) {
            const [name, value] = cookie.trim().split('=');
            if (name === 'auth') {
                token = value;
                break;
            }
        }
    }

    if (!token) {
        console.error('No auth token found');
        showToast('Authentication required. Please log in.', 'error');
        return;
    }

    const formData = new FormData();
    formData.append('file', data, filename);
    formData.append('fid', '0'); // Root folder

    try {
        const response = await fetch('/beta/api/v1/projects/upload', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`
            },
            body: formData
        });

        // Handle storage quota errors
        if (response.status === 507) {
            showToast('Export failed: Insufficient storage space.', 'error');
            return;
        }

        // Handle other errors
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({ message: response.statusText }));
            const errorMessage = errorData.message || response.statusText;
            showToast(`Export failed: ${errorMessage}`, 'error');
            return;
        }

        const result = await response.json();
        showToast(`Exported "${filename}" to your files!`, 'success');
        console.log('Export successful:', result);

    } catch (error) {
        console.error('Upload error:', error);
        showToast('Export failed due to a network error.', 'error');
    }
}

// Close modal when clicking outside of it
window.onclick = function(event) {
    const modal = document.getElementById('export-modal');
    if (event.target == modal) {
        closeExportModal();
    }
}

/**
 * Open preview page for sharing the 3D print
 * Generates/retrieves share_token and opens preview.php with the hash
 */
async function openPreview() {
    closeExportModal();

    // Check if project is saved
    if (!PROJECT_ID) {
        showToast('Please save your project first before sharing!', 'error');
        return;
    }

    // Check if there are models on the build plate
    if (typeof loadedModels === 'undefined' || loadedModels.length === 0) {
        showToast('No models on build plate to preview!', 'error');
        return;
    }

    try {
        showToast('Generating preview link...', 'info');

        // First, save the current state to ensure project data is up-to-date
        await saveProject();

        // Call API to generate/get share token and store it in database
        const response = await fetch(`/beta/api/v1/projects/${PROJECT_ID}/generate-share-token`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            credentials: 'include'
        });

        if (!response.ok) {
            throw new Error('Failed to generate share token');
        }

        const data = await response.json();
        const shareToken = data.share_token;

        if (!shareToken) {
            throw new Error('No share token received');
        }

        // Open preview page with the hash
        const previewUrl = `/beta/applications/3DPrinter/preview.php?hash=${shareToken}`;
        window.open(previewUrl, '_blank');

        showToast('Preview opened! You can copy the link from the preview page.', 'success');

    } catch (error) {
        console.error('Error opening preview:', error);
        showToast('Failed to generate preview link: ' + error.message, 'error');
    }
}

/**
 * Toggle collapsible section
 */
function toggleSection(sectionId) {
    const content = document.getElementById(sectionId);
    const header = content.previousElementSibling;

    if (content.classList.contains('show')) {
        content.classList.remove('show');
        header.classList.add('collapsed');
    } else {
        content.classList.add('show');
        header.classList.remove('collapsed');
    }
}

// ============================================================
// MULTI-MODEL MANAGEMENT
// ============================================================

/**
 * Create ghost preview mesh for a model
 */
function createGhostPreview(model) {
    if (!simulator || !simulator.scene) return;

    // Remove existing preview if any
    if (model.previewMesh) {
        model.previewMesh.dispose();
    }

    // Convert STL triangles to Babylon.js mesh
    const positions = [];
    const indices = [];

    for (let i = 0; i < model.mesh.length; i++) {
        const triangle = model.mesh[i];
        const baseIndex = i * 3;

        // Add vertices
        positions.push(triangle.v1.x, triangle.v1.y, triangle.v1.z);
        positions.push(triangle.v2.x, triangle.v2.y, triangle.v2.z);
        positions.push(triangle.v3.x, triangle.v3.y, triangle.v3.z);

        // Add indices
        indices.push(baseIndex, baseIndex + 1, baseIndex + 2);
    }

    // Create custom mesh
    const customMesh = new BABYLON.Mesh(`model_${model.id}`, simulator.scene);
    const vertexData = new BABYLON.VertexData();
    vertexData.positions = positions;
    vertexData.indices = indices;

    // Let Babylon.js compute normals automatically
    BABYLON.VertexData.ComputeNormals(positions, indices, vertexData.normals = []);

    vertexData.applyToMesh(customMesh);

    // Apply scaling first (before rotation so bounding box is calculated correctly)
    customMesh.scaling = new BABYLON.Vector3(model.scale.x, model.scale.y, model.scale.z);

    // Apply rotation
    customMesh.rotation = new BABYLON.Vector3(
        model.rotation.x * Math.PI / 180, // Convert to radians
        model.rotation.y * Math.PI / 180,
        model.rotation.z * Math.PI / 180
    );

    // Force Babylon to compute the world matrix NOW before we use it
    customMesh.computeWorldMatrix(true);

    // Manually calculate the minimum Z after rotation and scaling
    // This is more reliable than bounding box for complex meshes
    let minZ = Infinity;

    for (let i = 0; i < model.mesh.length; i++) {
        const triangle = model.mesh[i];

        // Transform each vertex to see where it ends up
        for (const vertex of [triangle.v1, triangle.v2, triangle.v3]) {
            let x = vertex.x * model.scale.x;
            let y = vertex.y * model.scale.y;
            let z = vertex.z * model.scale.z;

            // Apply rotation (using same matrix as transformVertex)
            const rotX = model.rotation.x * Math.PI / 180;
            const rotY = model.rotation.y * Math.PI / 180;
            const rotZ = model.rotation.z * Math.PI / 180;

            const cosX = Math.cos(rotX);
            const sinX = Math.sin(rotX);
            const cosY = Math.cos(rotY);
            const sinY = Math.sin(rotY);
            const cosZ = Math.cos(rotZ);
            const sinZ = Math.sin(rotZ);

            const m31 = sinY * cosX;
            const m32 = -sinX;
            const m33 = cosY * cosX;

            const rotatedZ = x * m31 + y * m32 + z * m33;

            if (rotatedZ < minZ) {
                minZ = rotatedZ;
            }
        }
    }

    // Set initial position (auto-drop will position correctly later)
    // For mesh: X and Z are horizontal (build plate), Y is vertical (height)
    // For model: X and Y are horizontal (build plate), Z is vertical (height)
    customMesh.position = new BABYLON.Vector3(
        model.position.x,  // Mesh X from model X
        model.position.z,  // Mesh Y (height) from model Z
        model.position.y   // Mesh Z from model Y
    );

    console.log(`Ghost preview for model ${model.id}:`);
    console.log(`  Mesh rotation (radians): x=${customMesh.rotation.x}, y=${customMesh.rotation.y}, z=${customMesh.rotation.z}`);
    console.log(`  Mesh rotation (degrees): x=${model.rotation.x}°, y=${model.rotation.y}°, z=${model.rotation.z}°`);
    console.log(`  Mesh position: x=${customMesh.position.x}, y=${customMesh.position.y}, z=${customMesh.position.z}`);
    console.log(`  Mesh scaling: x=${customMesh.scaling.x}, y=${customMesh.scaling.y}, z=${customMesh.scaling.z}`);
    console.log(`  Bounding box minZ: ${minZ}`);
    console.log(`  Model data will be saved as: pos.z=${model.position.z}`);

    // Test transformation - compare first vertex transformed by our function vs Babylon
    if (model.mesh.length > 0) {
        const testVertex = model.mesh[0].v1;

        // Get Babylon's world matrix for this mesh
        const worldMatrix = customMesh.getWorldMatrix();
        const babylonTransform = BABYLON.Vector3.TransformCoordinates(
            new BABYLON.Vector3(testVertex.x, testVertex.y, testVertex.z),
            worldMatrix
        );

        console.log(`  Transform test - original vertex: (${testVertex.x.toFixed(2)}, ${testVertex.y.toFixed(2)}, ${testVertex.z.toFixed(2)})`);
        console.log(`  Babylon transform: (${babylonTransform.x.toFixed(2)}, ${babylonTransform.y.toFixed(2)}, ${babylonTransform.z.toFixed(2)})`);

        // Extract the actual rotation matrix from Babylon's world matrix
        console.log(`  Babylon world matrix (first 3 rows):`);
        const m = worldMatrix.m;
        console.log(`    [${m[0].toFixed(3)}, ${m[1].toFixed(3)}, ${m[2].toFixed(3)}, ${m[3].toFixed(3)}]`);
        console.log(`    [${m[4].toFixed(3)}, ${m[5].toFixed(3)}, ${m[6].toFixed(3)}, ${m[7].toFixed(3)}]`);
        console.log(`    [${m[8].toFixed(3)}, ${m[9].toFixed(3)}, ${m[10].toFixed(3)}, ${m[11].toFixed(3)}]`);
    }

    // Create ghost material - semi-transparent solid
    const ghostMaterial = new BABYLON.StandardMaterial(`ghost_mat_${model.id}`, simulator.scene);
    ghostMaterial.diffuseColor = new BABYLON.Color3(0.3, 0.5, 0.8); // Blue
    ghostMaterial.specularColor = new BABYLON.Color3(0.1, 0.1, 0.1);
    ghostMaterial.emissiveColor = new BABYLON.Color3(0.05, 0.1, 0.15); // Slight glow
    ghostMaterial.alpha = 0.6; // More opaque to see positioning better
    ghostMaterial.backFaceCulling = true;

    customMesh.material = ghostMaterial;
    customMesh.renderingGroupId = 1;

    // Add wireframe edges to show model structure and positioning clearly
    customMesh.enableEdgesRendering();
    customMesh.edgesWidth = 2.0;
    customMesh.edgesColor = new BABYLON.Color4(0.8, 0.9, 1.0, 0.8); // Light blue edges

    // Make it pickable for selection
    customMesh.isPickable = true;
    customMesh.metadata = { modelId: model.id };

    model.previewMesh = customMesh;

    console.log(`Created ghost preview for model ${model.id}`);
}

/**
 * Update model list UI
 */
function updateModelList() {
    const container = document.getElementById('model-list');
    if (!container) return;

    if (loadedModels.length === 0) {
        container.innerHTML = '<div style="color: #888; font-size: 12px; padding: 10px; text-align: center;">No models loaded</div>';
        return;
    }

    let html = '';
    for (const model of loadedModels) {
        const isSelected = model.id === selectedModelId;
        html += `
            <div class="model-item ${isSelected ? 'selected' : ''}" onclick="selectModel(${model.id})">
                <div class="model-name">${model.name}</div>
                <div class="model-info">${(model.triangleCount / 1000).toFixed(1)}K triangles</div>
                <button class="btn-remove" onclick="event.stopPropagation(); removeModel(${model.id})">✕</button>
            </div>
        `;
    }

    container.innerHTML = html;
}

/**
 * Select a model for transformation
 */
function selectModel(modelId) {
    selectedModelId = modelId;

    // Update visual selection
    loadedModels.forEach(model => {
        if (model.previewMesh) {
            if (model.id === modelId) {
                // Highlight selected model
                model.previewMesh.material.emissiveColor = new BABYLON.Color3(0.2, 0.4, 0.6);
            } else {
                // Dim other models
                model.previewMesh.material.emissiveColor = new BABYLON.Color3(0, 0, 0);
            }
        }
    });

    // Update UI
    updateModelList();
    updateTransformInputs();

    // Attach gizmos to selected model
    attachGizmosToModel(modelId);
}

/**
 * Remove a model from the build plate
 */
function removeModel(modelId) {
    const index = loadedModels.findIndex(m => m.id === modelId);
    if (index === -1) return;

    const model = loadedModels[index];

    // Dispose preview mesh
    if (model.previewMesh) {
        model.previewMesh.dispose();
    }

    // Remove from array
    loadedModels.splice(index, 1);

    // Update selection
    if (selectedModelId === modelId) {
        selectedModelId = loadedModels.length > 0 ? loadedModels[0].id : null;
        if (selectedModelId) {
            selectModel(selectedModelId);
        }
    }

    // Update UI
    updateModelList();
    updateTransformInputs();

    // Disable slice button if no models
    if (loadedModels.length === 0) {
        updateSliceButton(true, '🔪 Slice');
        updateSliceStatus('Load STL models to slice');
    } else {
        updateSliceStatus(`${loadedModels.length} model(s) ready to slice`);
    }

    console.log(`Removed model ${modelId}`);
    markDirty();
}

/**
 * Update transform inputs with selected model values
 */
function updateTransformInputs() {
    const model = loadedModels.find(m => m.id === selectedModelId);

    if (!model) {
        // No model selected - disable inputs
        document.getElementById('model-pos-x').value = 0;
        document.getElementById('model-pos-y').value = 0;
        document.getElementById('model-pos-z').value = 0;
        document.getElementById('model-rotation-x').value = 0;
        document.getElementById('model-rotation-y').value = 0;
        document.getElementById('model-rotation-z').value = 0;
        document.getElementById('model-scale').value = 100;
        document.getElementById('transform-controls').style.opacity = '0.5';
        document.getElementById('transform-controls').style.pointerEvents = 'none';
        return;
    }

    // Enable and populate inputs
    document.getElementById('model-pos-x').value = model.position.x.toFixed(1);
    document.getElementById('model-pos-y').value = model.position.y.toFixed(1);
    document.getElementById('model-pos-z').value = model.position.z.toFixed(1);
    document.getElementById('model-rotation-x').value = model.rotation.x.toFixed(0);
    document.getElementById('model-rotation-y').value = model.rotation.y.toFixed(0);
    document.getElementById('model-rotation-z').value = model.rotation.z.toFixed(0);
    document.getElementById('model-scale').value = (model.scale.x * 100).toFixed(0);
    document.getElementById('transform-controls').style.opacity = '1';
    document.getElementById('transform-controls').style.pointerEvents = 'auto';

    // Update value displays
    document.getElementById('pos-x-value').textContent = model.position.x.toFixed(1);
    document.getElementById('pos-y-value').textContent = model.position.y.toFixed(1);
    document.getElementById('pos-z-value').textContent = model.position.z.toFixed(1);
    document.getElementById('rotation-x-value').textContent = model.rotation.x.toFixed(0);
    document.getElementById('rotation-y-value').textContent = model.rotation.y.toFixed(0);
    document.getElementById('rotation-z-value').textContent = model.rotation.z.toFixed(0);
    document.getElementById('scale-value').textContent = (model.scale.x * 100).toFixed(0);
}

/**
 * Update model position
 */
function updateModelPosition(axis, value) {
    const model = loadedModels.find(m => m.id === selectedModelId);
    if (!model) return;

    const numValue = parseFloat(value);
    model.position[axis] = numValue;

    // Update preview mesh
    // IMPORTANT: Swap Y and Z because mesh Y is up, but model Z is up
    if (model.previewMesh) {
        if (axis === 'x') {
            model.previewMesh.position.x = numValue;
        } else if (axis === 'y') {
            model.previewMesh.position.z = numValue;  // Model Y -> Mesh Z
        } else if (axis === 'z') {
            model.previewMesh.position.y = numValue;  // Model Z -> Mesh Y (height)
        }
    }

    // Update display
    document.getElementById(`pos-${axis}-value`).textContent = numValue.toFixed(1);
}

/**
 * Update model rotation for a specific axis (X, Y, or Z)
 */
function updateModelRotationAxis(axis, degrees) {
    const model = loadedModels.find(m => m.id === selectedModelId);
    if (!model) return;

    const numDegrees = parseFloat(degrees);
    model.rotation[axis] = numDegrees;

    // Update preview mesh - convert degrees to radians
    // Note: Babylon uses Y-up, so we need to map axes appropriately
    if (model.previewMesh) {
        if (axis === 'x') {
            model.previewMesh.rotation.x = numDegrees * Math.PI / 180;
        } else if (axis === 'y') {
            // Y rotation in 3D printing (around vertical) maps to Babylon Z rotation
            model.previewMesh.rotation.z = numDegrees * Math.PI / 180;
        } else if (axis === 'z') {
            // Z rotation in 3D printing maps to Babylon Y rotation
            model.previewMesh.rotation.y = numDegrees * Math.PI / 180;
        }
    }

    // Update display
    document.getElementById(`rotation-${axis}-value`).textContent = numDegrees.toFixed(0);

    markUnsavedChanges();
}

/**
 * Update model rotation (Z-axis only - legacy function for compatibility)
 */
function updateModelRotation(degrees) {
    updateModelRotationAxis('z', degrees);
}

/**
 * Update model scale
 */
function updateModelScale(percent) {
    const model = loadedModels.find(m => m.id === selectedModelId);
    if (!model) return;

    const scale = parseFloat(percent) / 100;
    model.scale.x = scale;
    model.scale.y = scale;
    model.scale.z = scale;

    // Update preview mesh
    if (model.previewMesh) {
        model.previewMesh.scaling = new BABYLON.Vector3(scale, scale, scale);
    }

    // Update display
    document.getElementById('scale-value').textContent = percent;
}

/**
 * Handle canvas click to select models
 */
function handleCanvasClick(event) {
    if (!simulator || !simulator.scene) return;

    // Get picking ray from camera
    const pickResult = simulator.scene.pick(simulator.scene.pointerX, simulator.scene.pointerY);

    // Check if we hit a model preview mesh
    if (pickResult.hit && pickResult.pickedMesh && pickResult.pickedMesh.metadata) {
        const modelId = pickResult.pickedMesh.metadata.modelId;
        if (modelId) {
            selectModel(modelId);
        }
    }
}

/**
 * Initialize gizmo manager for interactive transformations
 */
function initializeGizmos() {
    if (!simulator || !simulator.scene) return;

    // Create gizmo manager
    gizmoManager = new BABYLON.GizmoManager(simulator.scene);

    // Only enable position gizmo by default (others disabled)
    gizmoManager.positionGizmoEnabled = true;
    gizmoManager.rotationGizmoEnabled = false;
    gizmoManager.scaleGizmoEnabled = false;
    gizmoManager.boundingBoxGizmoEnabled = false;

    // Set gizmo thickness and scale (with safety checks)
    if (gizmoManager.gizmos && gizmoManager.gizmos.positionGizmo) {
        gizmoManager.gizmos.positionGizmo.scaleRatio = 1.5;
    }
    if (gizmoManager.gizmos && gizmoManager.gizmos.rotationGizmo) {
        gizmoManager.gizmos.rotationGizmo.scaleRatio = 1.5;
        // Enable all rotation axes (X, Y, Z) for full 3D orientation control
        gizmoManager.gizmos.rotationGizmo.xGizmo.isEnabled = true;
        gizmoManager.gizmos.rotationGizmo.yGizmo.isEnabled = true;
        gizmoManager.gizmos.rotationGizmo.zGizmo.isEnabled = true;
    }
    if (gizmoManager.gizmos && gizmoManager.gizmos.scaleGizmo) {
        gizmoManager.gizmos.scaleGizmo.scaleRatio = 1.5;
    }

    // Update model data when gizmo moves the mesh
    gizmoManager.onAttachedToMeshObservable.add((mesh) => {
        if (mesh && mesh.metadata && mesh.metadata.modelId) {
            // Set up drag end observers to update model data
            if (gizmoManager.gizmos.positionGizmo) {
                gizmoManager.gizmos.positionGizmo.xGizmo.dragBehavior.onDragEndObservable.add(() => updateModelFromGizmo(mesh));
                gizmoManager.gizmos.positionGizmo.yGizmo.dragBehavior.onDragEndObservable.add(() => updateModelFromGizmo(mesh));
                gizmoManager.gizmos.positionGizmo.zGizmo.dragBehavior.onDragEndObservable.add(() => updateModelFromGizmo(mesh));
            }
            if (gizmoManager.gizmos.rotationGizmo) {
                gizmoManager.gizmos.rotationGizmo.xGizmo.dragBehavior.onDragEndObservable.add(() => updateModelFromGizmo(mesh));
                gizmoManager.gizmos.rotationGizmo.yGizmo.dragBehavior.onDragEndObservable.add(() => updateModelFromGizmo(mesh));
                gizmoManager.gizmos.rotationGizmo.zGizmo.dragBehavior.onDragEndObservable.add(() => updateModelFromGizmo(mesh));
            }
            if (gizmoManager.gizmos.scaleGizmo) {
                gizmoManager.gizmos.scaleGizmo.uniformScaleGizmo.dragBehavior.onDragEndObservable.add(() => updateModelFromGizmo(mesh));
            }
        }
    });

    console.log('Gizmo manager initialized');
}

/**
 * Update model data from gizmo transformations
 */
function updateModelFromGizmo(mesh) {
    if (!mesh || !mesh.metadata || !mesh.metadata.modelId) return;

    const model = loadedModels.find(m => m.id === mesh.metadata.modelId);
    if (!model) return;

    // Store previous rotation to detect if it changed
    const prevRotX = model.rotation.x;
    const prevRotY = model.rotation.y;
    const prevRotZ = model.rotation.z;

    // Update model data from mesh transformations
    // IMPORTANT: For 3D printing, Z is up/down (height), but in Babylon the mesh uses Y as up
    // So we swap Y and Z when storing to model data
    model.position.x = mesh.position.x;
    model.position.y = mesh.position.z;  // Mesh Z becomes model Y (depth on build plate)
    model.position.z = mesh.position.y;  // Mesh Y becomes model Z (height above build plate)

    // Convert rotation from radians to degrees for all axes
    model.rotation.x = (mesh.rotation.x * 180 / Math.PI) % 360;
    model.rotation.y = (mesh.rotation.y * 180 / Math.PI) % 360;
    model.rotation.z = (mesh.rotation.z * 180 / Math.PI) % 360;

    model.scale.x = mesh.scaling.x;
    model.scale.y = mesh.scaling.y;
    model.scale.z = mesh.scaling.z;

    // If rotation changed, recalculate Z position to keep model on build plate
    const rotationChanged =
        Math.abs(model.rotation.x - prevRotX) > 0.1 ||
        Math.abs(model.rotation.y - prevRotY) > 0.1 ||
        Math.abs(model.rotation.z - prevRotZ) > 0.1;

    if (rotationChanged) {
        // Recalculate Z position so bottom stays on build plate
        const originalX = mesh.position.x;
        const originalY = mesh.position.y;

        mesh.position = new BABYLON.Vector3(0, 0, 0);
        mesh.computeWorldMatrix(true);
        mesh.refreshBoundingInfo();
        const boundingInfo = mesh.getBoundingInfo();
        const minZ = boundingInfo.boundingBox.minimumWorld.z;

        mesh.position = new BABYLON.Vector3(originalX, originalY, -minZ);
        model.position.z = -minZ;
    }

    // Update UI inputs
    updateTransformInputs();
}

/**
 * Attach gizmos to selected model
 */
function attachGizmosToModel(modelId) {
    if (!gizmoManager) return;

    const model = loadedModels.find(m => m.id === modelId);
    if (!model || !model.previewMesh) {
        gizmoManager.attachToMesh(null);
        return;
    }

    // Check if gizmos are enabled
    const gizmosEnabled = document.getElementById('show-gizmos').checked;
    if (!gizmosEnabled) {
        gizmoManager.attachToMesh(null);
        return;
    }

    // Attach gizmos to the preview mesh
    gizmoManager.attachToMesh(model.previewMesh);
}

/**
 * Toggle gizmo visibility
 */
function toggleGizmos(enabled) {
    if (!gizmoManager) return;

    // Show/hide gizmo type selector
    const selector = document.getElementById('gizmo-type-selector');
    if (selector) {
        selector.style.display = enabled ? 'block' : 'none';
    }

    if (enabled && selectedModelId) {
        // Re-attach gizmos to selected model
        attachGizmosToModel(selectedModelId);
    } else {
        // Detach gizmos
        gizmoManager.attachToMesh(null);
    }
}

/**
 * Change which gizmo type is active
 */
function changeGizmoType(type) {
    if (!gizmoManager) return;

    // Disable all gizmos first
    gizmoManager.positionGizmoEnabled = false;
    gizmoManager.rotationGizmoEnabled = false;
    gizmoManager.scaleGizmoEnabled = false;

    // Enable the selected gizmo type
    switch (type) {
        case 'position':
            gizmoManager.positionGizmoEnabled = true;
            break;
        case 'rotation':
            gizmoManager.rotationGizmoEnabled = true;
            break;
        case 'scale':
            gizmoManager.scaleGizmoEnabled = true;
            break;
    }

    // Re-attach to current model if one is selected
    if (selectedModelId && document.getElementById('show-gizmos').checked) {
        attachGizmosToModel(selectedModelId);
    }
}

/**
 * Drop selected model to build plate (align bottom to Z=0)
 */
function dropToBuildPlate() {
    const model = loadedModels.find(m => m.id === selectedModelId);
    if (!model || !model.previewMesh) {
        showToast('Please select a model first', 'error', 3000);
        return;
    }

    console.log('Drop to build plate - set height (mesh Y) so bottom touches build plate');

    // Store current horizontal position
    const currentMeshX = model.previewMesh.position.x;
    const currentMeshZ = model.previewMesh.position.z;

    // Force compute world matrix first
    model.previewMesh.computeWorldMatrix(true);

    // Get the WORLD bounding box (after all transformations)
    model.previewMesh.refreshBoundingInfo();
    const worldBBox = model.previewMesh.getBoundingInfo().boundingBox;

    // Find the lowest point in world Y (which is height)
    const worldMinY = worldBBox.minimumWorld.y;
    const worldMaxY = worldBBox.maximumWorld.y;

    console.log(`  World bbox Y: min=${worldMinY.toFixed(2)}, max=${worldMaxY.toFixed(2)}`);
    console.log(`  Current mesh position Y: ${model.previewMesh.position.y.toFixed(2)}`);

    // Detach gizmos before moving
    if (gizmoManager) {
        gizmoManager.attachToMesh(null);
    }

    // Calculate how much to move up so the bottom touches Y=0
    // If worldMinY is currently at -5, we need to add 5 to position.y
    // If worldMinY is currently at 10, we need to subtract 10 from position.y
    const offsetNeeded = -worldMinY;
    const newMeshY = model.previewMesh.position.y + offsetNeeded;

    console.log(`  Offset needed: ${offsetNeeded.toFixed(2)}`);
    console.log(`  New mesh Y will be: ${newMeshY.toFixed(2)}`);

    model.previewMesh.position.x = currentMeshX;     // Keep same (left/right)
    model.previewMesh.position.y = newMeshY;         // Drop to build plate (height)
    model.previewMesh.position.z = currentMeshZ;     // Keep same (forward/back)

    // Update model data (remember the Y/Z swap!)
    model.position.x = currentMeshX;                  // Mesh X -> Model X
    model.position.y = currentMeshZ;                  // Mesh Z -> Model Y
    model.position.z = newMeshY;                      // Mesh Y -> Model Z (height)

    console.log(`  AFTER drop  - mesh position X:${model.previewMesh.position.x.toFixed(2)}, Y:${model.previewMesh.position.y.toFixed(2)}, Z:${model.previewMesh.position.z.toFixed(2)}`);
    console.log(`  Model dropped! World min Y was ${worldMinY.toFixed(2)}, moved to mesh Y = ${newMeshY.toFixed(2)}`);

    // Force update
    model.previewMesh.computeWorldMatrix(true);

    // Reattach gizmos
    if (document.getElementById('show-gizmos').checked) {
        setTimeout(() => {
            if (gizmoManager) gizmoManager.attachToMesh(model.previewMesh);
        }, 10);
    }

    // Update UI
    updateTransformInputs();

    console.log(`Model dropped to build plate!`);
}

// ============================================================================
// PROJECT SAVE/LOAD SYSTEM
// ============================================================================

/**
 * Mark project as having unsaved changes
 */
function markDirty() {
    hasUnsavedChanges = true;
}

/**
 * Mark project as having unsaved changes
 */
function markUnsavedChanges() {
    hasUnsavedChanges = true;
}

/**
 * Helper to get element value with fallback
 */
function getElementValue(id, fallbackId, defaultValue) {
    const el = document.getElementById(id) || document.getElementById(fallbackId);
    return el ? el.value : defaultValue;
}

/**
 * Serialize current project state to JSON
 */
function serializeProjectData() {
    const data = {
        version: '1.0',
        models: [],
        settings: {
            layerHeight: parseFloat(getElementValue('dock-layer-height', 'learn-layer-height', '0.2')),
            nozzleDiameter: 0.4, // Fixed value - not exposed in UI
            infillPattern: getElementValue('dock-infill-pattern', 'learn-infill-pattern', 'grid'),
            infillDensity: parseInt(getElementValue('dock-infill-density', 'learn-infill-density', '20')),
            topBottomLayers: parseInt(getElementValue('dock-shell-layers', 'learn-shell-layers', '3')),
            filamentType: getElementValue('filament-type', 'learn-filament-type', 'PLA'),
            filamentColor: getElementValue('filament-color', 'learn-filament-color', '#FF6600'),
            lineThickness: 1.0, // Fixed value - not exposed in simple UI
            qualityPreset: getElementValue('quality-preset', 'learn-quality-preset', 'normal')
        },
        // Save print state - allows restoring printed models without re-simulating
        printState: {
            printComplete: isPrintComplete,
            gcode: currentGCode || null  // Save G-code for quick restoration
        }
    };

    // Serialize loaded models
    for (const model of loadedModels) {
        const modelData = {
            id: model.id,
            name: model.name,
            position: model.position,
            rotation: model.rotation,
            scale: model.scale,
            url: model.url || null  // Save URL for reloading if available
        };

        // Generate STL text from mesh data for preview purposes
        // This allows the card preview to render the model without fetching external URLs
        if (model.mesh && model.mesh.length > 0) {
            modelData.stlData = generateSTLFromMesh(model.mesh, model.name);
        }

        data.models.push(modelData);
    }

    return data;
}

/**
 * Generate STL text from mesh triangle data
 */
function generateSTLFromMesh(mesh, name) {
    let stl = `solid ${name || 'model'}\n`;

    for (const triangle of mesh) {
        const n = triangle.normal || { x: 0, y: 0, z: 1 };
        stl += `  facet normal ${n.x} ${n.y} ${n.z}\n`;
        stl += `    outer loop\n`;
        stl += `      vertex ${triangle.v1.x} ${triangle.v1.y} ${triangle.v1.z}\n`;
        stl += `      vertex ${triangle.v2.x} ${triangle.v2.y} ${triangle.v2.z}\n`;
        stl += `      vertex ${triangle.v3.x} ${triangle.v3.y} ${triangle.v3.z}\n`;
        stl += `    endloop\n`;
        stl += `  endfacet\n`;
    }

    stl += `endsolid ${name || 'model'}\n`;
    return stl;
}

/**
 * Load project data and restore state
 */
function loadProjectData(data) {
    if (!data || !data.settings) {
        console.log('No project data to load');
        return;
    }

    console.log('Loading project data:', data);

    // Restore settings (check both dock and legacy element IDs)
    const settings = data.settings;

    // Helper to set value on element if it exists
    const setElementValue = (id, value) => {
        const el = document.getElementById(id);
        if (el && value !== undefined) el.value = value;
    };

    // Helper to set text content if element exists
    const setElementText = (id, text) => {
        const el = document.getElementById(id);
        if (el && text !== undefined) el.textContent = text;
    };

    // Restore settings to dock elements (primary) and legacy elements (fallback)
    if (settings.layerHeight) {
        setElementValue('dock-layer-height', settings.layerHeight);
        setElementValue('layer-height', settings.layerHeight);
        setElementText('dock-layer-height-value', settings.layerHeight);
        setElementText('layer-height-value', settings.layerHeight);
    }
    if (settings.nozzleDiameter) {
        setElementValue('dock-line-thickness', settings.nozzleDiameter);
        setElementValue('line-thickness', settings.nozzleDiameter);
        setElementText('dock-line-thickness-value', settings.nozzleDiameter);
    }
    if (settings.infillPattern) {
        setElementValue('dock-infill-pattern', settings.infillPattern);
        setElementValue('infill-pattern', settings.infillPattern);
    }
    if (settings.infillDensity) {
        setElementValue('dock-infill-density', settings.infillDensity);
        setElementValue('infill-density', settings.infillDensity);
        setElementText('dock-infill-density-value', settings.infillDensity);
        setElementText('infill-density-value', settings.infillDensity);
    }
    if (settings.topBottomLayers) {
        setElementValue('dock-shell-layers', settings.topBottomLayers);
        setElementValue('top-bottom-layers', settings.topBottomLayers);
        setElementText('dock-shell-layers-value', settings.topBottomLayers);
        setElementText('top-bottom-layers-value', settings.topBottomLayers);
    }
    if (settings.filamentType) {
        setElementValue('dock-filament-type', settings.filamentType);
        setElementValue('filament-type', settings.filamentType);
    }
    if (settings.filamentColor) {
        setElementValue('filament-color', settings.filamentColor);
        if (simulator) simulator.setFilamentColor(settings.filamentColor);
    }
    if (settings.qualityPreset) {
        setElementValue('dock-quality-preset', settings.qualityPreset);
        setElementValue('quality-preset', settings.qualityPreset);
    }

    // Restore models (only those loaded from URLs)
    if (data.models && data.models.length > 0) {
        console.log(`Restoring ${data.models.length} models...`);
        
        // Wait for scene to be ready
        setTimeout(() => {
            for (const modelData of data.models) {
                if (modelData.url) {
                    // Model was loaded from URL - reload it
                    console.log(`Reloading model from URL: ${modelData.url}`);
                    loadSTLFromURLCore(modelData.url).then(() => {
                        // After loading, apply saved transform
                        const loadedModel = loadedModels[loadedModels.length - 1];
                        if (loadedModel) {
                            loadedModel.position = modelData.position;
                            loadedModel.rotation = modelData.rotation;
                            loadedModel.scale = modelData.scale;
                            
                            // Apply to preview mesh
                            if (loadedModel.previewMesh) {
                                loadedModel.previewMesh.position = new BABYLON.Vector3(
                                    modelData.position.x,
                                    modelData.position.y,
                                    modelData.position.z
                                );
                                loadedModel.previewMesh.rotation = new BABYLON.Vector3(
                                    BABYLON.Tools.ToRadians(modelData.rotation.x),
                                    BABYLON.Tools.ToRadians(modelData.rotation.y),
                                    BABYLON.Tools.ToRadians(modelData.rotation.z)
                                );
                                loadedModel.previewMesh.scaling = new BABYLON.Vector3(
                                    modelData.scale.x,
                                    modelData.scale.y,
                                    modelData.scale.z
                                );
                            }
                        }
                    });
                } else {
                    // Model was uploaded from file - can't reload, notify user
                    console.warn(`Model "${modelData.name}" was uploaded from file and cannot be restored. Please re-upload.`);
                }
            }
        }, 1000);
    }

    // Restore print state if project was saved after printing
    if (data.printState && data.printState.printComplete && data.printState.gcode) {
        console.log('Restoring completed print from saved G-code...');
        isPrintComplete = true;

        // Wait for scene to be ready, then restore the print using quick print
        setTimeout(() => {
            // Load the G-code
            loadGCode(data.printState.gcode);

            // Set temperatures instantly
            if (simulator) {
                simulator.currentHotendTemp = simulator.targetHotendTemp;
                simulator.currentBedTemp = simulator.targetBedTemp;
                const tempEl = document.getElementById('hud-temp');
                const bedTempEl = document.getElementById('hud-bed-temp');
                if (tempEl) tempEl.textContent = `${simulator.currentHotendTemp}°C`;
                if (bedTempEl) bedTempEl.textContent = `${simulator.currentBedTemp}°C`;

                // Apply saved filament color
                if (data.settings && data.settings.filamentColor) {
                    simulator.setFilamentColor(data.settings.filamentColor);
                }

                // Use quick print to instantly render the completed print
                // Skip finalQualityRender (3D tubes) — line mesh is sufficient for restore
                showToast('Restoring print...', 'info', 1500);
                simulator.quickPrint(() => {
                    showToast('Print restored!', 'success', 2000);
                    console.log('Print restoration complete!');
                }, true);
            }
        }, 1500); // Wait for models to load first
    } else {
        isPrintComplete = false;
    }

    hasUnsavedChanges = false;
}

/**
 * Warn before leaving with unsaved changes
 */
window.addEventListener('beforeunload', function(e) {
    if (hasUnsavedChanges) {
        e.preventDefault();
        e.returnValue = 'You have unsaved changes. Leave anyway?';
        return e.returnValue;
    }
});

// ============================================================================
// LEARNING MODE & UI ENHANCEMENTS
// ============================================================================

let learningMode = false;  // Default to standard mode

/**
 * Set mode (Learning or Standard)
 */
function setMode(isLearning) {
    learningMode = isLearning;

    // Update body class for CSS mode switching
    if (isLearning) {
        document.body.classList.remove('standard-mode');
        document.body.classList.add('learning-mode');
    } else {
        document.body.classList.remove('learning-mode');
        document.body.classList.add('standard-mode');
    }

    // Update toggle buttons
    document.getElementById('learning-mode-btn').classList.toggle('active', isLearning);
    document.getElementById('standard-mode-btn').classList.toggle('active', !isLearning);

    // Learning mode defaults
    if (isLearning) {
        const learnStepMode = document.getElementById('learn-step-mode');
        if (learnStepMode) {
            learnStepMode.checked = true;
            stepMode = true;
        }
    }

    // Update G-code annotations display
    updateGCodeAnnotations(isLearning);

    console.log(`Mode changed to: ${isLearning ? 'Learning' : 'Standard'}`);
}

/**
 * Toggle HUD visibility (minimize/expand)
 */
function toggleHUD() {
    const hud = document.getElementById('printer-hud');
    hud.classList.toggle('minimized');

    // Save preference
    localStorage.setItem('3dprinter_hud_minimized', hud.classList.contains('minimized'));
}

/**
 * Update HUD with current printer status
 */
function updateHUD(data) {
    // Use padded strings to prevent jumping
    const layer = String(data.layer || 0).padStart(3, ' ');
    const totalLayers = String(data.totalLayers || 0).padStart(3, ' ');
    const line = String(data.line || 0).padStart(5, ' ');
    const totalLines = String(data.totalLines || 0).padStart(5, ' ');
    const x = (data.x || 0).toFixed(1).padStart(6, ' ');
    const y = (data.y || 0).toFixed(1).padStart(6, ' ');
    const z = (data.z || 0).toFixed(1).padStart(5, ' ');
    const temp = String(data.temp || 0).padStart(3, ' ');
    const bedTemp = String(data.bedTemp || 0).padStart(3, ' ');
    const percent = (data.percent || 0).toFixed(1).padStart(5, ' ');

    document.getElementById('hud-layer').textContent = `${layer}/${totalLayers}`;
    document.getElementById('hud-line').textContent = `${line}/${totalLines}`;
    document.getElementById('hud-pos-x').textContent = x;
    document.getElementById('hud-pos-y').textContent = y;
    document.getElementById('hud-pos-z').textContent = z;

    // Determine status: Extruding, Retracting, Moving, or Idle
    let status = 'Idle';
    if (data.extruding) {
        status = 'Extruding';
    } else if (data.retracting) {
        status = 'Retracting';
    } else if (data.line > 0 && data.percent < 100) {
        status = 'Moving';
    }
    document.getElementById('hud-status').textContent = status;

    document.getElementById('hud-temp').textContent = `${temp}°C`;
    document.getElementById('hud-bed-temp').textContent = `${bedTemp}°C`;

    document.getElementById('hud-progress-fill').style.width = `${data.percent || 0}%`;
    document.getElementById('hud-percent').textContent = `${percent}%`;
}

/**
 * Switch dock tab (Settings or G-code)
 */
function switchDockTab(tabName) {
    // Update tab active states
    document.querySelectorAll('.dock-tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.tab === tabName);
    });

    // Update panel visibility
    document.querySelectorAll('.dock-panel').forEach(panel => {
        panel.classList.remove('active');
    });

    const activePanel = document.getElementById(`dock-${tabName}-panel`);
    if (activePanel) {
        activePanel.classList.add('active');
    }
}

/**
 * Toggle dock collapsed/expanded
 */
function toggleDock() {
    const dock = document.getElementById('bottom-dock');
    const toggleBtn = dock.querySelector('.dock-toggle');

    dock.classList.toggle('collapsed');
    toggleBtn.textContent = dock.classList.contains('collapsed') ? '▲' : '▼';

    // Save preference
    localStorage.setItem('3dprinter_dock_collapsed', dock.classList.contains('collapsed'));
}

/**
 * Toggle Learning Mode step-through
 */
function toggleLearnStepMode(enabled) {
    stepMode = enabled;
    updateStepControls();
}

/**
 * Set Learning Mode playback speed
 */
function setLearnSpeed(speed) {
    const speedValue = parseFloat(speed);
    if (simulator) {
        simulator.setSpeed(speedValue);
    }
}

/**
 * Play in Learning Mode (simple shape)
 */
function playLearningMode() {
    const playBtn = document.getElementById('learn-play-btn');

    if (!simulator.commands || simulator.commands.length === 0) {
        showToast('Please generate a shape first!', 'error', 3000);
        return;
    }

    // Toggle play/pause
    if (simulator.isPlaying) {
        simulator.pause();
        playBtn.textContent = '▶ Play';
    } else {
        playBtn.textContent = '⏸ Pause';
        simulator.play();
    }
}

/**
 * Generate shape for Learning Mode
 */
function generateLearningShape() {
    const shapeType = document.getElementById('shape-type').value;
    const shapeSize = parseInt(document.getElementById('shape-size').value);
    const infillPattern = document.getElementById('learn-infill-pattern').value;
    const infillDensity = parseInt(document.getElementById('learn-infill-density').value);

    let gcodeText;

    switch (shapeType) {
        case 'cube':
            gcodeText = generator.generateCube(shapeSize, shapeSize, infillPattern, infillDensity, 3);
            break;
        case 'cylinder':
            gcodeText = generator.generateCylinder(shapeSize, shapeSize, infillPattern, infillDensity, 3);
            break;
        case 'pyramid':
            gcodeText = generator.generatePyramid(shapeSize, shapeSize, infillPattern, infillDensity, 3);
            break;
        default:
            gcodeText = generator.generateCube(shapeSize, shapeSize, infillPattern, infillDensity, 3);
    }

    // Load G-code with annotations for learning mode
    loadGCode(gcodeText);
    updateGCodeAnnotations(true);

    // Auto-start in step mode
    stepMode = true;
    updateStepControls();

    console.log(`Generated ${shapeType} (${shapeSize}mm) with ${infillPattern} pattern at ${infillDensity}% density`);

    // Auto-start the print simulation
    setTimeout(() => {
        playSimulation();
    }, 100);
}

/**
 * G-code annotation lookup
 */
const gcodeAnnotations = {
    'G0': 'Rapid move - Move quickly without extruding',
    'G1': 'Linear move - Move while potentially extruding filament',
    'G28': 'Home - Return print head to origin position',
    'G90': 'Absolute positioning mode',
    'G91': 'Relative positioning mode',
    'G92': 'Set current position',
    'M104': 'Set hotend temperature (no wait)',
    'M109': 'Wait for hotend to reach temperature',
    'M140': 'Set bed temperature (no wait)',
    'M190': 'Wait for bed to reach temperature',
    'M106': 'Turn on cooling fan',
    'M107': 'Turn off cooling fan',
    'M82': 'Absolute extrusion mode',
    'M83': 'Relative extrusion mode',
    'X': 'Move left/right on build plate',
    'Y': 'Move forward/back on build plate',
    'Z': 'Move up/down (layer height)',
    'E': 'Extrude filament amount',
    'F': 'Set movement speed (mm/min)'
};

/**
 * Update G-code display with annotations (for Learning Mode)
 */
function updateGCodeAnnotations(showAnnotations) {
    const dockDisplay = document.getElementById('dock-gcode-display');
    if (!dockDisplay || !currentGCode) return;

    const lines = currentGCode.split('\n');
    let html = '';

    lines.forEach((line, index) => {
        const trimmed = line.trim();
        let annotation = '';
        let cssClass = 'gcode-line-wrapper';
        let cmdClass = '';

        if (trimmed.startsWith(';')) {
            cmdClass = 'gcode-comment';
        } else if (trimmed.startsWith('G0') || trimmed.startsWith('G1')) {
            cmdClass = 'gcode-move';
            if (showAnnotations) {
                const hasE = trimmed.includes('E');
                annotation = hasE ? 'Extruding filament while moving' : 'Travel move (no extrusion)';
            }
        } else if (trimmed.startsWith('G28')) {
            cmdClass = 'gcode-home';
            if (showAnnotations) annotation = gcodeAnnotations['G28'];
        } else if (trimmed.match(/^M10[49]/)) {
            cmdClass = 'gcode-temp';
            if (showAnnotations) annotation = gcodeAnnotations[trimmed.substring(0, 4)];
        } else if (trimmed.match(/^M1[49]0/)) {
            cmdClass = 'gcode-temp';
            if (showAnnotations) annotation = gcodeAnnotations[trimmed.substring(0, 4)];
        }

        html += `<div class="${cssClass}" data-line="${index}">`;
        html += `<span class="gcode-cmd ${cmdClass}">${index + 1}: ${line || ' '}</span>`;
        if (showAnnotations && annotation) {
            html += `<span class="gcode-annotation">← ${annotation}</span>`;
        }
        html += '</div>';
    });

    dockDisplay.innerHTML = html;
}

/**
 * Initialize dock resize functionality
 */
function initDockResize() {
    const dock = document.getElementById('bottom-dock');
    const handle = dock.querySelector('.dock-resize-handle');

    if (!handle) return;

    let isResizing = false;
    let startY = 0;
    let startHeight = 0;

    handle.addEventListener('mousedown', (e) => {
        isResizing = true;
        startY = e.clientY;
        startHeight = dock.offsetHeight;
        handle.classList.add('resizing');
        document.body.style.cursor = 'ns-resize';
        document.body.style.userSelect = 'none';
        e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
        if (!isResizing) return;

        const deltaY = startY - e.clientY;
        const newHeight = Math.min(400, Math.max(100, startHeight + deltaY));
        dock.style.height = newHeight + 'px';

        // Save immediately
        localStorage.setItem('3dprinter_dock_height', newHeight);
    });

    document.addEventListener('mouseup', () => {
        if (isResizing) {
            isResizing = false;
            handle.classList.remove('resizing');
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        }
    });
}

/**
 * Load UI state from localStorage
 */
function loadUIState() {
    // Dock height
    const dockHeight = localStorage.getItem('3dprinter_dock_height');
    if (dockHeight) {
        const dock = document.getElementById('bottom-dock');
        if (dock) dock.style.height = dockHeight + 'px';
    }

    // Dock collapsed state
    const dockCollapsed = localStorage.getItem('3dprinter_dock_collapsed');
    if (dockCollapsed === 'true') {
        const dock = document.getElementById('bottom-dock');
        if (dock) {
            dock.classList.add('collapsed');
            const toggleBtn = dock.querySelector('.dock-toggle');
            if (toggleBtn) toggleBtn.textContent = '▲';
        }
    }

    // HUD minimized state
    const hudMinimized = localStorage.getItem('3dprinter_hud_minimized');
    if (hudMinimized === 'true') {
        const hud = document.getElementById('printer-hud');
        if (hud) hud.classList.add('minimized');
    }

    // Always default to Standard mode on load
    setMode(false);
}

/**
 * Sync dock settings with main settings
 */
function syncDockSettings() {
    // Sync dock inputs with main inputs
    const syncPairs = [
        ['dock-line-thickness', 'line-thickness'],
        ['dock-layer-height', 'layer-height'],
        ['dock-quality-preset', 'quality-preset'],
        ['dock-infill-pattern', 'infill-pattern'],
        ['dock-infill-density', 'infill-density'],
        ['dock-shell-layers', 'top-bottom-layers'],
        ['dock-filament-type', 'filament-type'],
        ['dock-hotend-temp', 'hotend-temp'],
        ['dock-bed-temp', 'bed-temp']
    ];

    syncPairs.forEach(([dockId, mainId]) => {
        const dockInput = document.getElementById(dockId);
        const mainInput = document.getElementById(mainId);

        if (dockInput && mainInput) {
            // Sync dock -> main on change
            dockInput.addEventListener('input', () => {
                mainInput.value = dockInput.value;
                mainInput.dispatchEvent(new Event('input'));
            });

            dockInput.addEventListener('change', () => {
                mainInput.value = dockInput.value;
                mainInput.dispatchEvent(new Event('change'));
            });

            // Initial sync main -> dock
            dockInput.value = mainInput.value;
        }
    });

    // Update value displays for dock sliders
    document.getElementById('dock-line-thickness')?.addEventListener('input', (e) => {
        document.getElementById('dock-line-thickness-value').textContent = parseFloat(e.target.value).toFixed(1);
    });

    document.getElementById('dock-layer-height')?.addEventListener('input', (e) => {
        document.getElementById('dock-layer-height-value').textContent = parseFloat(e.target.value).toFixed(2);
    });

    document.getElementById('dock-infill-density')?.addEventListener('input', (e) => {
        document.getElementById('dock-infill-density-value').textContent = e.target.value;
    });

    document.getElementById('dock-shell-layers')?.addEventListener('input', (e) => {
        document.getElementById('dock-shell-layers-value').textContent = e.target.value;
    });

    document.getElementById('dock-hotend-temp')?.addEventListener('input', (e) => {
        document.getElementById('dock-hotend-temp-value').textContent = e.target.value;
    });

    document.getElementById('dock-bed-temp')?.addEventListener('input', (e) => {
        document.getElementById('dock-bed-temp-value').textContent = e.target.value;
    });
}

// Initialize UI enhancements when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    // Wait a bit for other initializations
    setTimeout(() => {
        loadUIState();
        initDockResize();
        syncDockSettings();

        // Learning Mode generate button
        const generateLearnBtn = document.getElementById('generate-learn-btn');
        if (generateLearnBtn) {
            generateLearnBtn.addEventListener('click', generateLearningShape);
        }

        // Learning color picker sync
        const learnColorPicker = document.getElementById('learn-filament-color');
        if (learnColorPicker) {
            learnColorPicker.addEventListener('input', (e) => {
                simulator.setFilamentColor(e.target.value);
            });
        }

        console.log('UI enhancements initialized');
    }, 200);
});

// Note: updateProgress now directly updates the HUD, no override needed

// ============================================================
// LIGHTING CONTROLS
// ============================================================

/**
 * Update lighting based on slider values
 */
function updateLighting() {
    if (!simulator) return;

    const brightness = parseInt(document.getElementById('light-brightness')?.value || 80);
    const shadowSoftness = parseInt(document.getElementById('shadow-softness')?.value || 70);
    const detailLevel = parseInt(document.getElementById('detail-level')?.value || 70);

    // Update display values
    const brightnessEl = document.getElementById('brightness-value');
    const shadowEl = document.getElementById('shadow-value');
    const detailEl = document.getElementById('detail-value');

    if (brightnessEl) brightnessEl.textContent = brightness;
    if (shadowEl) shadowEl.textContent = shadowSoftness;
    if (detailEl) detailEl.textContent = detailLevel;

    // Apply lighting settings to simulator
    simulator.updateLighting({
        brightness: brightness / 100,        // 0.3 - 1.5
        shadowSoftness: shadowSoftness / 100, // 0 - 1
        detailLevel: detailLevel / 100        // 0 - 1
    });
}

/**
 * Apply a lighting preset
 */
function applyLightingPreset(preset) {
    let brightness, shadowSoftness, detailLevel;

    switch (preset) {
        case 'layers':
            brightness = 60;
            shadowSoftness = 30;
            detailLevel = 50;
            break;
        case 'soft':
            brightness = 70;
            shadowSoftness = 90;
            detailLevel = 50;
            break;
        case 'studio':
            brightness = 100;
            shadowSoftness = 60;
            detailLevel = 70;
            break;
        case 'dramatic':
            brightness = 120;
            shadowSoftness = 30;
            detailLevel = 90;
            break;
        case 'flat':
            brightness = 60;
            shadowSoftness = 100;
            detailLevel = 20;
            break;
        default:
            brightness = 60;
            shadowSoftness = 30;
            detailLevel = 50;
    }

    // Update sliders
    const brightnessSlider = document.getElementById('light-brightness');
    const shadowSlider = document.getElementById('shadow-softness');
    const detailSlider = document.getElementById('detail-level');

    if (brightnessSlider) brightnessSlider.value = brightness;
    if (shadowSlider) shadowSlider.value = shadowSoftness;
    if (detailSlider) detailSlider.value = detailLevel;

    // Apply the changes
    updateLighting();

    showToast(`Applied "${preset}" lighting preset`, 'info', 2000);
}

// ============================================================================
// PLATFORM INTEGRATION EXPORTS
// ============================================================================
window.serializeProjectData = serializeProjectData;
window.loadProjectData = loadProjectData;
