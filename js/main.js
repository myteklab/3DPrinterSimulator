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
    simulator.onPrintRemoved = onPrintRemoved;

    // Set up click-to-select on canvas
    canvas.addEventListener('click', handleCanvasClick);

    // Initialize gizmo manager (wait for scene to be ready)
    setTimeout(() => {
        if (simulator && simulator.scene) {
            initializeGizmos();
        }
    }, 100);

    // Check for URL parameters to auto-load STL
    const hasStlParam = checkURLParameters();

    // A new project used to open on an empty plate with Slice greyed out. It opens on the same
    // little house /try shows; a saved project or a /try seed replaces it when it arrives.
    if (!hasStlParam) setTimeout(loadStarter, 400);

    console.log('3D Printer Simulator initialized');
});

let starterOnPlate = false;
let projectLoaded = false;

async function loadStarter() {
    if (projectLoaded || loadedModels.length) return;
    try {
        const res = await fetch('samples/house.stl');
        if (!res.ok) return;
        const text = await res.text();
        if (projectLoaded || loadedModels.length) return;
        const model = await loadSTLFromTextCore(text, 'Little house');
        if (!model) return;
        starterOnPlate = true;
        selectModel(model.id);
        showStarterHint(true);
    } catch (e) {
        console.warn('Starter model not loaded:', e);
    }
}

function clearStarter() {
    if (!starterOnPlate) return;
    starterOnPlate = false;
    loadedModels.slice().forEach(m => removeModel(m.id, true));
    showStarterHint(false);
}

function showStarterHint(on) {
    const el = document.getElementById('starter-hint');
    if (el) el.hidden = !on || learningMode;
}

// Only the plastic not yet laid down can change color, as on a real printer
function pickFilamentColor(hex) {
    simulator.setFilamentColor(hex);
    if (simulator.lockedPrintColor && simulator.commands && simulator.commands.length) {
        showToast('The new color loads for the next print. A printer cannot recolor plastic it has already laid down.', 'info', 4000);
    }
}

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
    // The platform adapter unhides this and opens the picker; outside the platform it stays hidden.
    document.getElementById('asset-stl-btn').addEventListener('click', () => window.dispatchEvent(new CustomEvent('printersim:pickAsset')));

    // Slice settings (with null checks for elements that may be in dock instead)
    const qualityPreset = document.getElementById('dock-quality-preset');
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
    document.getElementById('show-overhangs').addEventListener('change', (e) => simulator.setOverhangsVisible(e.target.checked));
    document.getElementById('dock-supports').addEventListener('change', () => markDirty());
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
            pickFilamentColor(hex);
            console.log(`Filament color: ${hex}`);
        });
    }

    initSwatches();
    document.querySelectorAll('#gizmo-mode button').forEach(b => b.addEventListener('click', () => setGizmoMode(b.dataset.gizmo)));

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
    const at = simulator.currentCommandIndex || 0;
    ['step-forward-btn', 'learn-next-layer'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.disabled = !hasGCode || at >= simulator.commands.length;
    });
    ['step-back-btn', 'learn-prev-layer'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.disabled = !hasGCode || at === 0;
    });
}

function layerOf(i) {
    const cmd = simulator.commands[i];
    return cmd && cmd.layer ? cmd.layer : 0;
}

function afterStep() {
    simulator.currentHotendTemp = simulator.targetHotendTemp;
    simulator.currentBedTemp = simulator.targetBedTemp;
    const tempEl = document.getElementById('hud-temp');
    if (tempEl) tempEl.textContent = `${simulator.currentHotendTemp}°C`;
    const bedEl = document.getElementById('hud-bed-temp');
    if (bedEl) bedEl.textContent = `${simulator.currentBedTemp}°C`;
    setGhosts(false, false);
    const i = simulator.currentCommandIndex;
    const cmd = simulator.commands[i - 1] || {};
    updateProgress({
        commandIndex: i,
        totalCommands: simulator.commands.length,
        layer: cmd.layer || 0,
        position: cmd.to || { x: 0, y: 0, z: 0 },
        extruding: cmd.extruding || false
    });
    updateGCodeHighlight(i - 1);
    updateStepControls();
    showLayerInfo(cmd.layer || 0);
}

function formatSpeed(v) {
    return v.toFixed(v < 1 ? 2 : (v < 10 ? 1 : 0));
}

function applySpeed(v) {
    v = parseFloat(v);
    if (!(v > 0)) return;
    const slider = document.getElementById('speed-slider');
    if (slider) slider.value = v;
    const label = document.getElementById('speed-value');
    if (label) label.textContent = formatSpeed(v);
    simulator.setSpeed(v);
}

function sliderSpeed() {
    return parseFloat((document.getElementById('speed-slider') || {}).value) || 1;
}

function stopPlayingForStep() {
    if (simulator.isPlaying) simulator.pause();
    // a heat-up still running would start the old print once it finished, even after a new Slice
    if (simulator.isHeating) {
        clearInterval(simulator.heatupInterval);
        simulator.isHeating = false;
    }
    const learnPlay = document.getElementById('learn-play-btn');
    if (learnPlay) learnPlay.textContent = '\u25B6 Play';
    const playBtn = document.getElementById('play-btn');
    if (playBtn) { playBtn.disabled = false; playBtn.innerHTML = '\u25B6 Print'; }
    const pauseBtn = document.getElementById('pause-btn');
    if (pauseBtn) pauseBtn.disabled = true;
}

/**
 * Next: finish the layer the nozzle is on (setup moves count as part of layer 1).
 * It stepped one G-code line before, which looked like nothing happened.
 */
function stepForward() {
    if (!simulator.commands || simulator.currentCommandIndex >= simulator.commands.length) return;
    stopPlayingForStep();
    let i = simulator.currentCommandIndex;
    const target = Math.max(1, layerOf(i));
    while (i < simulator.commands.length && layerOf(i) <= target) {
        simulator.executeCommand(simulator.commands[i]);
        i++;
    }
    simulator.currentCommandIndex = i;
    afterStep();
}

/** Previous: back to the end of the layer below. */
function stepBack() {
    if (!simulator.commands || simulator.currentCommandIndex <= 0) return;
    stopPlayingForStep();
    const target = layerOf(simulator.currentCommandIndex - 1) - 1;
    simulator.reset();
    let i = 0;
    if (target >= 1) {
        while (i < simulator.commands.length && layerOf(i) <= target) {
            simulator.executeCommand(simulator.commands[i]);
            i++;
        }
    }
    simulator.currentCommandIndex = i;
    afterStep();
}

/** One line under Previous and Next on what the layer just printed is. */
let shownLayer = 0;

function showLayerInfo(layer) {
    shownLayer = layer;
    const el = document.getElementById('learn-layer-info');
    if (!el) return;
    const total = simulator.totalLayers || 0;
    if (!layer) { el.textContent = 'Press Next to print the first layer.'; return; }
    const shells = 3;
    const shape = (document.getElementById('shape-type') || {}).value;
    let what;
    if (layer <= shells) what = 'A solid layer: the bottom is filled in completely so the part has a floor.';
    else if (shape !== 'pyramid' && layer > total - shells) what = 'A solid layer: the top is filled in so the part has a roof, hiding the infill below.';
    else what = 'The nozzle draws the wall around the edge, then the infill pattern inside. Most of the inside is air.';
    el.textContent = `Layer ${layer} of ${total}, ${(layer * 0.2).toFixed(1)} mm up. ${what}`;
}

/**
 * Handle quality preset selection
 */
function handleQualityPreset() {
    const preset = (document.getElementById('dock-quality-preset') || {}).value || 'normal';
    // Quality on a real slicer is mostly layer height: thinner layers, smoother sides, longer print
    const layer = { fast: 0.3, normal: 0.2, detailed: 0.1 }[preset] || 0.2;
    const sim = { fast: [10.0, 1], normal: [4.0, 2], detailed: [2.0, 3] }[preset] || [4.0, 2];
    simulator.useLineRendering = true;
    simulator.setSimplificationLevel(sim[0]);
    simulator.setLayerMergeInterval(sim[1]);
    const lh = document.getElementById('dock-layer-height');
    if (lh) lh.value = layer;
    const lv = document.getElementById('dock-layer-height-value');
    if (lv) lv.textContent = layer.toFixed(2);

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

        const resting = restingRotation(tempSlicer.mesh, bbox);

        const model = {
            id: modelId,
            name: file.name,
            file: file,
            mesh: tempSlicer.mesh,
            previewMesh: null,
            // Position so bottom of model sits on build plate (Z=0)
            position: { x: 0, y: 0, z: 0 },
            // Rotate -90° around X axis to lay flat if needed
            rotation: resting,
            scale: { x: 1, y: 1, z: 1 },
            boundingBox: bbox,
            triangleCount: triangleCount
        };

        // Add to loaded models
        clearStarter();
        loadedModels.push(model);

        // Create ghost preview mesh
        createGhostPreview(model);
        autoFitModel(model);

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
        updateSliceButton(false, 'Slice');
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
/**
 * STL files carry no units, and many are drawn in meters or inches, so a model can arrive a
 * couple of millimeters across or bigger than the bed. Scale it to something printable and say so.
 */
function autoFitModel(model) {
    const size = model.boundingBox && model.boundingBox.size;
    if (!size) return;
    const biggest = Math.max(size.x, size.y, size.z);
    if (!(biggest > 0)) return;
    let target = null;
    if (biggest < 10) target = 40;
    else if (biggest > 180) target = 150;
    if (!target) return;
    const k = target / biggest;
    model.scale = { x: k, y: k, z: k };
    if (model.previewMesh) model.previewMesh.scaling = new BABYLON.Vector3(k, k, k);
    showToast(`This model was ${biggest.toFixed(biggest < 10 ? 1 : 0)} mm across, so it was scaled to ${target} mm. Change it with Scale.`, 'info', 5000);
}

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
    return !!stlUrl;
}

/**
 * Core function to load STL from URL
 */
// opts.name: a picked file arrives as /a/{id}, which carries no filename.
// opts.keepUrl false stores the geometry instead, the way an uploaded STL is,
// so the project still opens if the file is later deleted or renamed.
async function loadSTLFromURLCore(url, opts = {}) {
    const loadBtn = opts.button || document.getElementById('load-url-btn');
    const originalText = loadBtn.textContent;

    try {
        loadBtn.disabled = true;
        loadBtn.textContent = 'Loading...';

        console.log('Fetching STL from URL:', url);

        // Fetch the STL file
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`HTTP error ${response.status}: ${response.statusText}`);
        }

        // Get filename from URL or Content-Disposition header
        let filename = opts.name || 'model.stl';
        const contentDisposition = response.headers.get('Content-Disposition');
        if (opts.name) {
            // named by the caller
        } else if (contentDisposition) {
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

        const resting = restingRotation(tempSlicer.mesh, bbox);

        const model = {
            id: modelId,
            name: filename,
            file: file,
            mesh: tempSlicer.mesh,
            previewMesh: null,
            position: { x: 0, y: 0, z: 0 },
            rotation: resting,
            scale: { x: 1, y: 1, z: 1 },
            boundingBox: bbox,
            triangleCount: triangleCount,
            url: opts.keepUrl === false ? null : url
        };

        // Add to loaded models
        clearStarter();
        loadedModels.push(model);

        // Create ghost preview mesh
        createGhostPreview(model);
        autoFitModel(model);

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
        updateSliceButton(false, 'Slice');
        updateSliceStatus(`${loadedModels.length} model(s) ready to slice`);

        console.log(`Model loaded from URL: ${filename} (${triangleCount} triangles)`);

        // Mark as changed
        markDirty();

        // Clear URL input
        document.getElementById('stl-url').value = '';

    } catch (error) {
        console.error('Error loading STL from URL:', error);
        // "Failed to fetch" is what a browser says for a dead link and for a site that refuses
        // to share its files with other sites alike
        const why = opts.name ? `Could not load "${opts.name}": ${error.message}`
            : /Failed to fetch|NetworkError|Load failed/i.test(error.message)
            ? 'Could not download that file. Check the link, and use a direct link to the .stl file itself. Some sites (Thingiverse, Printables) do not let other sites download their files, so download it to your computer and use Upload an STL file instead.'
            : `Could not load that STL: ${error.message}`;
        showToast(why, 'error', 8000);
    } finally {
        loadBtn.disabled = false;
        loadBtn.textContent = originalText;
    }
}

/**
 * Restore an uploaded model from STL text saved inside a project.
 * Mirrors loadSTLFromURLCore but skips the fetch since the geometry
 * is already in hand. Used by loadProjectData when modelData has no url.
 */
// Called with the file a student picked from My Files. The picker offers every
// 3D model, and the slicer reads only STL.
window.loadSTLFromAsset = function (url, name) {
    name = name || 'model.stl';
    if (!/\.stl$/i.test(name)) {
        const ext = (name.match(/\.([a-z0-9]+)$/i) || [])[1];
        showToast((ext ? `"${name}" is a .${ext.toLowerCase()} file. ` : '') + 'The printer reads .stl files: pick an STL, or export one from your 3D design app.', 'error', 8000);
        return Promise.resolve();
    }
    return loadSTLFromURLCore(url, { name, keepUrl: false, button: document.getElementById('asset-stl-btn') });
};

async function loadSTLFromTextCore(stlText, name) {
    try {
        const tempSlicer = new STLSlicer();
        tempSlicer.parseSTLText(stlText);
        if (!tempSlicer.mesh || tempSlicer.mesh.length === 0) {
            console.warn(`Restored STL "${name}" parsed to zero triangles, skipping`);
            return null;
        }
        const bbox = tempSlicer.getBoundingBox();
        const triangleCount = tempSlicer.mesh.length;
        const modelId = ++modelIdCounter;

        const model = {
            id: modelId,
            name: name || 'restored.stl',
            file: null,
            mesh: tempSlicer.mesh,
            previewMesh: null,
            position: { x: 0, y: 0, z: 0 },
            rotation: { x: 0, y: 0, z: 0 },
            scale: { x: 1, y: 1, z: 1 },
            boundingBox: bbox,
            triangleCount: triangleCount,
        };

        loadedModels.push(model);
        createGhostPreview(model);
        updateModelList();
        updateSliceButton(false, 'Slice');
        updateSliceStatus(`${loadedModels.length} model(s) ready to slice`);
        return model;
    } catch (error) {
        console.error('Error restoring STL from saved data:', error);
        return null;
    }
}

/**
 * Slice all models on build plate into G-code
 */
async function sliceSTL() {
    showStarterHint(false);
    stopPlayingForStep();
    if (loadedModels.length === 0) {
        showToast('Please load at least one STL model first!', 'error', 3000);
        return;
    }

    updateSliceButton(true, 'Slicing...');
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
            updateSliceButton(false, 'Slice');
            return;
        }

        if (minZ > 0.1) {
            const proceed = confirm(`Warning: Model is floating ${minZ.toFixed(2)}mm above build plate.\n\nThis will waste filament printing air. Continue anyway?`);
            if (!proceed) {
                updateSliceButton(false, 'Slice');
                return;
            }
        }

        // Create a temporary slicer with the combined mesh
        const tempSlicer = new STLSlicer();
        tempSlicer.mesh = combinedMesh;
        tempSlicer.layerHeight = layerHeight;
        tempSlicer.topBottomLayers = topBottomLayers;
        tempSlicer.nozzleDiameter = nozzleDiameter;
        tempSlicer.supportMode = (document.getElementById('dock-supports') || {}).value || 'none';

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

        updateSliceButton(false, 'Sliced');
        updateSliceStatus(`Generated ${layers.length} layers`);
        
        setTimeout(() => {
            updateSliceButton(false, 'Slice');
            updateSliceStatus(`${loadedModels.length} model(s) ready to slice`);
        }, 2000);

        console.log(`Slicing complete! Generated ${layers.length} layers from ${loadedModels.length} model(s)`);

        // The model stays on show after Slice (it vanished until Print before); the print hides it
        setGhosts(true, false);

        // Detach gizmos during print
        if (gizmoManager) {
            gizmoManager.attachToMesh(null);
        }

    } catch (error) {
        console.error('Slicing error:', error);
        showToast(`Slicing failed: ${error.message}`, 'error', 5000);
        updateSliceButton(false, 'Slice');
        updateSliceStatus('Slicing failed - check console');
    }
}

// Which side the model rests on when it arrives. STL files are Z-up by
// convention (BlocksCAD, Tinkercad, OpenSCAD), which here is a -90 turn on X.
// The old rule, "deeper than tall means turn it", left tall Z-up models lying on
// their side. Now Z-up is kept whenever its bottom has a real flat area, and a
// side with one is used only when the Z-up bottom has none, which is what a
// Y-up export from a 3D app looks like. With no flat side anywhere (a sphere,
// a scan) the old rule decides.
const RESTING_CANDIDATES = [
    { x: -90, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 90, y: 0, z: 0 },
    { x: 180, y: 0, z: 0 }, { x: 0, y: 0, z: 90 }, { x: 0, y: 0, z: -90 }
];
// Measured with Babylon's own rotation, because slicing reads the preview mesh
// (world Y is up there); transformVertex's matrix gives the opposite sign.
function restingRotation(mesh, bbox) {
    const size = Math.max(bbox.size.x, bbox.size.y, bbox.size.z) || 1;
    const tol = size * 0.002;
    const d = Math.PI / 180;
    let best = null, bestArea = 0, zUpArea = 0;
    for (const rot of RESTING_CANDIDATES) {
        const m = BABYLON.Matrix.RotationYawPitchRoll(rot.y * d, rot.x * d, rot.z * d).m;
        // world Y of a point under this rotation (row vector times matrix, column 1)
        const up = (p) => p.x * m[1] + p.y * m[5] + p.z * m[9];
        const heights = new Float64Array(mesh.length * 3);
        let minH = Infinity;
        for (let i = 0; i < mesh.length; i++) {
            const t = mesh[i];
            heights[i * 3] = up(t.v1); heights[i * 3 + 1] = up(t.v2); heights[i * 3 + 2] = up(t.v3);
            minH = Math.min(minH, heights[i * 3], heights[i * 3 + 1], heights[i * 3 + 2]);
        }
        let area = 0;
        for (let i = 0; i < mesh.length; i++) {
            if (heights[i * 3] - minH > tol || heights[i * 3 + 1] - minH > tol || heights[i * 3 + 2] - minH > tol) continue;
            const t = mesh[i];
            const ax = t.v2.x - t.v1.x, ay = t.v2.y - t.v1.y, az = t.v2.z - t.v1.z;
            const bx = t.v3.x - t.v1.x, by = t.v3.y - t.v1.y, bz = t.v3.z - t.v1.z;
            area += Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx) / 2;
        }
        if (rot === RESTING_CANDIDATES[0]) zUpArea = area;
        if (area > bestArea) { bestArea = area; best = rot; }
    }
    const flat = size * size * 0.01;
    if (zUpArea >= flat) return { x: -90, y: 0, z: 0 };
    if (bestArea >= flat) return { ...best };
    return bbox.size.y > bbox.size.z ? { x: -90, y: 0, z: 0 } : { x: 0, y: 0, z: 0 };
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

// Walls printed over air. Each layer's walls come first in the slicer's
// G-code (before "; Sparse" or "; Solid"); a stretch of wall is over air when
// it sits more than OVERHANG_REACH outside the walls of the layer below,
// which is steeper than the 45 degrees a printer manages on its own. Read from
// the G-code so a reopened print shows them too, without slicing again.
const OVERHANG_REACH = 0.25;
function findOverhangs(gcodeText) {
    const layers = [];
    let layer = null, loop = null;
    for (const raw of gcodeText.split('\n')) {
        const line = raw.trim();
        const head = line.match(/^; Layer \d+ \(Z=([\d.]+)\)/);
        if (head) { layer = { z: parseFloat(head[1]), loops: [], walls: true }; layers.push(layer); loop = null; continue; }
        if (!layer || !layer.walls) continue;
        if (line.startsWith('; S')) { layer.walls = false; continue; }
        const x = line.match(/X(-?[\d.]+)/), y = line.match(/Y(-?[\d.]+)/);
        if (!x || !y) continue;
        const pt = [parseFloat(x[1]), parseFloat(y[1])];
        if (line.startsWith('G0') || !loop) { loop = [pt]; layer.loops.push(loop); } else loop.push(pt);
    }
    const inside = (p, loops) => {
        let n = 0;
        for (const l of loops) {
            const [x0, y0, x1, y1] = box(l);
            if (p[1] < y0 || p[1] > y1 || p[0] > x1) continue;
            for (let i = 0, j = l.length - 1; i < l.length; j = i++) {
                if ((l[i][1] > p[1]) !== (l[j][1] > p[1]) && p[0] < (l[j][0] - l[i][0]) * (p[1] - l[i][1]) / (l[j][1] - l[i][1]) + l[i][0]) n++;
            }
        }
        return n % 2 === 1;
    };
    const boxes = new Map();
    const box = (l) => {
        if (!boxes.has(l)) {
            let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
            for (const [x, y] of l) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
            boxes.set(l, [x0 - OVERHANG_REACH, y0 - OVERHANG_REACH, x1 + OVERHANG_REACH, y1 + OVERHANG_REACH]);
        }
        return boxes.get(l);
    };
    const near = (p, loops) => {
        for (const l of loops) {
            const [x0, y0, x1, y1] = box(l);
            if (p[0] < x0 || p[0] > x1 || p[1] < y0 || p[1] > y1) continue;
            for (let i = 1; i < l.length; i++) {
                const [ax, ay] = l[i - 1], [bx, by] = l[i];
                const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
                const t = len2 ? Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / len2)) : 0;
                if (Math.hypot(ax + t * dx - p[0], ay + t * dy - p[1]) <= OVERHANG_REACH) return true;
            }
        }
        return false;
    };
    const out = [];
    for (let k = 1; k < layers.length; k++) {
        const below = layers[k - 1].loops, runs = [];
        for (const l of layers[k].loops) {
            let run = null;
            for (let i = 1; i < l.length; i++) {
                const a = l[i - 1], b = l[i];
                const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1])));
                for (let s = 0; s < steps; s++) {
                    const p0 = [a[0] + (b[0] - a[0]) * s / steps, a[1] + (b[1] - a[1]) * s / steps];
                    const p1 = [a[0] + (b[0] - a[0]) * (s + 1) / steps, a[1] + (b[1] - a[1]) * (s + 1) / steps];
                    const mid = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
                    if (inside(mid, below) || near(mid, below)) { run = null; continue; }
                    if (!run) { run = [p0]; runs.push(run); }
                    run.push(p1);
                }
            }
        }
        if (runs.length) out.push({ z: layers[k].z, runs });
    }
    return out;
}

// A highlight that stands apart from the filament: blue, or pink on a blue print.
function overhangColor() {
    const hex = (document.getElementById('filament-color') || {}).value || '#ff6b35';
    const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    const bluish = b > r + 30 && b >= g - 20;
    return bluish ? { hex: '#f472b6', name: 'pink' } : { hex: '#38bdf8', name: 'blue' };
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
    const overhangs = findOverhangs(gcodeText);
    simulator.setOverhangs(overhangs, overhangColor().hex);
    simulator.setOverhangsVisible(document.getElementById('show-overhangs')?.checked !== false);
    if (overhangs.length && !learningMode) {
        const supported = /; Support/.test(gcodeText);
        showToast(supported
            ? `The ${overhangColor().name} parts print over air. The supports hold them up while they print, then snap off.`
            : `The ${overhangColor().name} parts print over air, with nothing under them. Turn on Supports and slice again, or change the model so it has a flatter bottom.`, 'info', 8000);
    }

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

    simulator.setSpeed(sliderSpeed());
    const playBtn = document.getElementById('play-btn');
    const quickPrintEl = document.getElementById('quick-print');
    const quickPrintMode = quickPrintEl ? quickPrintEl.checked : false;

    if (quickPrintMode) {
        // Quick print mode - skip animation and heat-up
        playBtn.disabled = true;
        playBtn.innerHTML = 'Quick printing...';

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
        setGhosts(false, false);
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

    if (learningMode && progress.layer && progress.layer !== shownLayer) {
        shownLayer = progress.layer;
        showLayerInfo(progress.layer);
    }

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

    // Mark print as complete for save/restore. A restored print finishing is not a change:
    // counting it made an untouched project ask "Leave site?"
    isPrintComplete = true;
    if (!restoringPrint) markUnsavedChanges();

    // Show completion toast
    showToast('Print simulation complete!', 'success', 3000);

    // Auto-save screenshot for preview (after a short delay for final render)
    setTimeout(() => {
        saveScreenshot();
    }, 500);
}

/**
 * Called when a finished print is removed from the bed via click interaction
 */
function onPrintRemoved() {
    isPrintComplete = false;
    showToast('Print removed from bed', 'info', 2000);
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
            // If print is complete and we have toolpath data, export printed geometry
            if (isPrintComplete && simulator.allPathSegments && simulator.allPathSegments.length > 0) {
                const layerHeight = parseFloat(document.getElementById('dock-layer-height')?.value) || 0.2;
                simulator.exportPrintedGLB(layerHeight);
            } else {
                simulator.exportAsGLTF();
            }
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
 * Generate GLB data for export.
 * Clones the original model geometry, bakes transforms, and applies
 * per-vertex layer-line coloring based on the filament color and
 * current layer height to give a 3D-printed appearance.
 */
async function generateGLBData() {
    if (!simulator || !simulator.scene) {
        return null;
    }

    // If print is complete and we have toolpath data, export printed geometry
    if (isPrintComplete && simulator.allPathSegments && simulator.allPathSegments.length > 0) {
        const layerHeight = parseFloat(document.getElementById('dock-layer-height')?.value) || 0.2;
        return await simulator.exportPrintedGLBData(layerHeight);
    }

    const clones = [];
    const layerHeight = parseFloat(document.getElementById('dock-layer-height')?.value) || 0.2;
    const baseColor = simulator.lockedPrintColor || simulator.filamentColor;

    for (const model of loadedModels) {
        if (!model.previewMesh) continue;

        // Clone so we don't modify the original
        const clone = model.previewMesh.clone('export_' + (model.id || clones.length), null, true, false);
        clone.position = model.previewMesh.position.clone();
        clone.rotation = model.previewMesh.rotation.clone();
        clone.scaling = model.previewMesh.scaling.clone();
        clone.setEnabled(true);
        clone.computeWorldMatrix(true);
        clone.bakeCurrentTransformIntoVertices();

        const positions = clone.getVerticesData(BABYLON.VertexBuffer.PositionKind);
        if (!positions) { clone.dispose(); continue; }

        // Find height range (Y is up in Babylon.js)
        let minY = Infinity;
        for (let i = 1; i < positions.length; i += 3) {
            if (positions[i] < minY) minY = positions[i];
        }

        // Build per-vertex colors with layer-line banding
        const vertexCount = positions.length / 3;
        const colors = new Float32Array(vertexCount * 4);
        for (let v = 0; v < vertexCount; v++) {
            const y = positions[v * 3 + 1];
            const layerNum = Math.floor((y - minY) / layerHeight);
            // Alternate: full brightness / slightly darker each layer
            const shade = (layerNum % 2 === 0) ? 1.0 : 0.82;
            colors[v * 4]     = baseColor.r * shade;
            colors[v * 4 + 1] = baseColor.g * shade;
            colors[v * 4 + 2] = baseColor.b * shade;
            colors[v * 4 + 3] = 1.0;
        }
        clone.setVerticesData(BABYLON.VertexBuffer.ColorKind, colors);
        clones.push(clone);
    }

    if (clones.length === 0) {
        return null;
    }

    // White diffuse so vertex colors come through unmodified
    const exportMaterial = new BABYLON.StandardMaterial("export_material", simulator.scene);
    exportMaterial.diffuseColor = new BABYLON.Color3(1, 1, 1);
    exportMaterial.specularColor = new BABYLON.Color3(0.15, 0.15, 0.15);
    exportMaterial.alpha = 1.0;
    exportMaterial.backFaceCulling = false;

    for (const mesh of clones) {
        mesh.material = exportMaterial;
    }

    try {
        const result = await BABYLON.GLTF2Export.GLBAsync(simulator.scene, 'build_plate_models', {
            shouldExportNode: (node) => clones.includes(node)
        });
        return result.glTFFiles['build_plate_models.glb'];
    } finally {
        for (const clone of clones) {
            clone.dispose();
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
        container.innerHTML = '<div class="empty-note">Nothing on the plate yet.</div>';
        return;
    }

    let html = '';
    for (const model of loadedModels) {
        const isSelected = model.id === selectedModelId;
        html += `
            <div class="model-item ${isSelected ? 'selected' : ''}" onclick="selectModel(${model.id})">
                <div class="model-name">${model.name}</div>
                <div class="model-info">${model.triangleCount < 1000 ? model.triangleCount : (model.triangleCount / 1000).toFixed(1) + 'K'} triangles</div>
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
function removeModel(modelId, quiet) {
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
        updateSliceButton(true, 'Slice');
        updateSliceStatus('Nothing on the plate. Add an STL, or switch to Learning to print a cube.');
    } else {
        updateSliceStatus(`${loadedModels.length} model(s) ready to slice`);
    }

    console.log(`Removed model ${modelId}`);
    // quiet: swapping the starter for a saved project is not a change to that project
    if (!quiet) markDirty();
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
    const scaleSlider = document.getElementById('model-scale');
    scaleSlider.max = Math.max(300, Math.ceil(model.scale.x * 100 * 2 / 5) * 5);
    scaleSlider.value = (model.scale.x * 100).toFixed(0);
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

    if (enabled && selectedModelId) {
        // Re-attach gizmos to selected model
        attachGizmosToModel(selectedModelId);
    } else {
        // Detach gizmos
        gizmoManager.attachToMesh(null);
    }
}

// The Off / Move / Rotate / Scale buttons drive the hidden checkbox and select
// that the rest of the gizmo code reads.
function setGizmoMode(mode) {
    const on = mode !== 'off';
    document.getElementById('show-gizmos').checked = on;
    if (on) {
        document.getElementById('gizmo-type').value = mode;
        changeGizmoType(mode);
    }
    toggleGizmos(on);
    document.querySelectorAll('#gizmo-mode button').forEach(b => b.classList.toggle('active', b.dataset.gizmo === mode));
}

// A swatch sets the color input beside it and fires its input event, so the
// handlers and the save code see one color source, as before.
function initSwatches() {
    document.querySelectorAll('.swatches').forEach(group => {
        const input = document.getElementById(group.dataset.for);
        if (!input) return;
        group.addEventListener('click', (e) => {
            const b = e.target.closest('button[data-color]');
            if (!b) return;
            input.value = b.dataset.color;
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        input.addEventListener('input', markSwatches);
    });
    markSwatches();
}
function markSwatches() {
    document.querySelectorAll('.swatches').forEach(group => {
        const input = document.getElementById(group.dataset.for);
        if (!input) return;
        const v = input.value.toLowerCase();
        group.querySelectorAll('button[data-color]').forEach(b => b.classList.toggle('active', b.dataset.color === v));
    });
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
            filamentType: getElementValue('dock-filament-type', 'filament-type', 'pla'),
            supports: getElementValue('dock-supports', 'dock-supports', 'none'),
            filamentColor: getElementValue('filament-color', 'learn-filament-color', '#FF6600'),
            lineThickness: 1.0, // Fixed value - not exposed in simple UI
            qualityPreset: getElementValue('dock-quality-preset', 'quality-preset', 'normal'),
            speed: parseFloat(getElementValue('speed-slider', 'speed-slider', '1')),
            learn: {
                shape: getElementValue('shape-type', 'shape-type', 'cube'),
                size: getElementValue('shape-size', 'shape-size', '20'),
                pattern: getElementValue('learn-infill-pattern', 'learn-infill-pattern', 'grid'),
                density: getElementValue('learn-infill-density', 'learn-infill-density', '20'),
                speed: getElementValue('learn-speed', 'learn-speed', '5')
            }
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
    projectLoaded = true;
    clearStarter();

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
    setElementValue('dock-supports', settings.supports || 'none');
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
        // Saves before the dock select was read stored 'PLA', which matches no option.
        setElementValue('dock-filament-type', String(settings.filamentType).toLowerCase());
        setElementValue('filament-type', settings.filamentType);
    }
    if (settings.filamentColor) {
        setElementValue('filament-color', settings.filamentColor);
        markSwatches();
        if (simulator) simulator.setFilamentColor(settings.filamentColor);
    }
    if (settings.qualityPreset) {
        setElementValue('dock-quality-preset', settings.qualityPreset);
        setElementValue('quality-preset', settings.qualityPreset);
    }
    if (settings.layerHeight) {
        // the preset sets a layer height of its own, so the saved one goes back after it
        setElementValue('dock-layer-height', settings.layerHeight);
        setElementText('dock-layer-height-value', Number(settings.layerHeight).toFixed(2));
    }
    if (settings.speed) {
        setElementValue('speed-slider', settings.speed);
        setElementText('speed-value', formatSpeed(Number(settings.speed)));
        if (simulator) simulator.setSpeed(settings.speed);
    }
    if (settings.learn) {
        setElementValue('shape-type', settings.learn.shape);
        setElementValue('shape-size', settings.learn.size);
        setElementValue('learn-infill-pattern', settings.learn.pattern);
        setElementValue('learn-infill-density', settings.learn.density);
        setElementValue('learn-speed', settings.learn.speed);
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
                } else if (modelData.stlData) {
                    // Model was uploaded from file - restore from embedded STL geometry
                    console.log(`Restoring uploaded model "${modelData.name}" from saved STL data...`);
                    loadSTLFromTextCore(modelData.stlData, modelData.name).then((restored) => {
                        if (!restored) return;
                        restored.position = modelData.position;
                        restored.rotation = modelData.rotation;
                        restored.scale = modelData.scale;
                        if (restored.previewMesh) {
                            restored.previewMesh.position = new BABYLON.Vector3(
                                modelData.position.x,
                                modelData.position.y,
                                modelData.position.z
                            );
                            restored.previewMesh.rotation = new BABYLON.Vector3(
                                BABYLON.Tools.ToRadians(modelData.rotation.x),
                                BABYLON.Tools.ToRadians(modelData.rotation.y),
                                BABYLON.Tools.ToRadians(modelData.rotation.z)
                            );
                            restored.previewMesh.scaling = new BABYLON.Vector3(
                                modelData.scale.x,
                                modelData.scale.y,
                                modelData.scale.z
                            );
                        }
                    });
                } else {
                    console.warn(`Model "${modelData.name}" has no URL or saved geometry, cannot restore.`);
                }
            }
        }, 1000);
    }

    // Restore print state if project was saved after printing
    if (data.printState && data.printState.printComplete && data.printState.gcode) {
        console.log('Restoring completed print from saved G-code...');
        isPrintComplete = true;
        restoringPrint = true;

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
                    restoringPrint = false;
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

function setGhosts(visible, pickable) {
    loadedModels.forEach(model => {
        if (!model.previewMesh) return;
        model.previewMesh.setEnabled(visible);
        model.previewMesh.isPickable = !!pickable;
    });
}
let restoringPrint = false;

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

    if (simulator) stopPlayingForStep();
    if (isLearning) {
        const learnStepMode = document.getElementById('learn-step-mode');
        stepMode = !!(learnStepMode && learnStepMode.checked);
        if (simulator) applySpeed((document.getElementById('learn-speed') || {}).value || 5);
    }
    // the Standard house's outline stayed drawn over Learning prints
    setGhosts(!isLearning, !isLearning);
    showStarterHint(starterOnPlate);

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
    if (simulator) applySpeed(speed);
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
        playBtn.textContent = '\u275A\u275A Pause';
        simulator.setSpeed(sliderSpeed());
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

    stopPlayingForStep();
    loadGCode(gcodeText);
    updateGCodeAnnotations(true);

    // the bottom bar showed Grid 20% while this panel said Honeycomb 50%
    const dockPattern = document.getElementById('dock-infill-pattern');
    if (dockPattern && [...dockPattern.options].some(o => o.value === infillPattern)) dockPattern.value = infillPattern;
    const dockDensity = document.getElementById('dock-infill-density');
    if (dockDensity) dockDensity.value = infillDensity;
    const dockDensityValue = document.getElementById('dock-infill-density-value');
    if (dockDensityValue) dockDensityValue.textContent = infillDensity;
    const stepEl = document.getElementById('learn-step-mode');
    stepMode = !!(stepEl && stepEl.checked);
    updateStepControls();
    showLayerInfo(0);
    // Previous and Next sat below the fold; bring them up
    const playback = document.getElementById('learn-playback-section');
    if (playback && playback.scrollIntoView) playback.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    markDirty();

    console.log(`Generated ${shapeType} (${shapeSize}mm) with ${infillPattern} pattern at ${infillDensity}% density`);

    if (stepMode) {
        setTimeout(stepForward, 100);
    } else {
        setTimeout(() => {
            playSimulation();
            const learnPlay = document.getElementById('learn-play-btn');
            if (learnPlay) learnPlay.textContent = '\u23F8 Pause';
        }, 100);
    }
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

        // Learning color picker sync
        const learnColorPicker = document.getElementById('learn-filament-color');
        if (learnColorPicker) {
            learnColorPicker.addEventListener('input', (e) => {
                pickFilamentColor(e.target.value);
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
            // The filament color is the material's diffuse and emissive color at once, so a bright
            // ground light saturates it on every face. Kept near Layers, which shades well.
            brightness = 65;
            shadowSoftness = 40;
            detailLevel = 55;
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
            shadowSoftness = 45;
            detailLevel = 45;
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

    updateLighting();
    document.querySelectorAll('#lighting-presets button').forEach(b => b.classList.toggle('active', b.dataset.preset === preset));
}

// ============================================================================
// PLATFORM INTEGRATION EXPORTS
// ============================================================================
window.serializeProjectData = serializeProjectData;
window.loadProjectData = loadProjectData;
