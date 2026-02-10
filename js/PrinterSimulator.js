/**
 * 3D Printer Simulator with Babylon.js
 * Renders printer, build plate, and progressively builds geometry
 */
class PrinterSimulator {
    constructor(canvas) {
        this.canvas = canvas;
        this.engine = new BABYLON.Engine(canvas, true, { preserveDrawingBuffer: true });
        // Render at CSS pixel resolution (not retina) to reduce GPU load in iframe
        this.engine.setHardwareScalingLevel(1);
        this.scene = null;
        this.camera = null;
        this.printHead = null;
        this.buildPlate = null;
        this.printedGeometry = [];
        this.pathLines = [];
        this.commands = [];
        this.currentCommandIndex = 0;
        this.isPlaying = false;
        this.speed = 1.0;
        this.nozzleDiameter = 0.4;
        this.layerMergeInterval = 3; // Merge geometry every N layers (reduced from 5)
        this.mergedMeshes = [];
        this.simplificationLevel = 1.0; // 1.0 = normal, 2.0 = skip every other segment, etc.
        this.maxGeometryCount = 5000; // Max geometry pieces before forcing merge
        this.useLineRendering = true; // Use lines instead of cylinders for massive performance boost
        this.allPoints = []; // All points for the entire print (single array)
        this.pathSegments = []; // Array of separate path segments (for travel move breaks)
        this.allPathSegments = []; // Permanent storage of ALL segments for final quality render (never cleared during freezing)
        this.currentSegment = []; // Current segment being built
        this.lineMesh = null; // Single updateable line mesh
        this.updateCounter = 0; // Counter to batch updates
        this.lineThickness = 0.4; // Nozzle diameter in mm (default 0.4mm - standard size)
        this.filamentColor = new BABYLON.Color3(1, 0.42, 0.21); // Default orange
        this.lockedPrintColor = null; // Color locked at start of print to prevent mid-print changes
        this.rainbowMode = false; // Rainbow layers for learning
        this.printMaterial = null; // Reusable material for print mesh
        this.frameAccumulator = 0; // For handling fractional speeds
        this.lastFrameTime = 0;
        this.printHeadPosition = new BABYLON.Vector3(0, 20, 0); // Current smooth position
        this.printHeadTargetPosition = new BABYLON.Vector3(0, 20, 0); // Target position
        this.printHeadLerpSpeed = 10; // Interpolation speed

        // Smooth interpolation for realistic slow-speed printing
        this.commandProgress = 0; // 0 to 1, progress through current command
        this.useInterpolation = false; // Enable at slow speeds only
        this.lastInterpolatedPosition = null; // Last position where we added geometry

        // Performance optimization - cache tube meshes to avoid constant recreation
        this.tubeMeshCache = []; // Cache of reusable tube meshes
        this.lastSegmentCount = 0; // Track if segments changed

        // Temperature simulation
        this.currentHotendTemp = 20; // Room temperature
        this.currentBedTemp = 20;
        this.targetHotendTemp = 200; // PLA default
        this.targetBedTemp = 60;
        this.isHeating = false;
        this.heatupInterval = null;
        this.lastTempFluctuation = 0; // Timestamp for throttling fluctuation updates

        // Quick print mode
        this.quickPrintMode = false;

        // Performance optimization - freeze old geometry
        this.maxActiveSegments = 20; // REDUCED: Maximum segments to rebuild each frame (was 30)
        this.frozenMeshes = []; // Array of frozen geometry meshes
        this.totalPointCount = 0; // Running counter for rainbow mode layer calculation
        this.frozenMaterial = null; // Shared material for all frozen segments (non-rainbow)
        this.activeMaterial = null; // Cached material for the active segment
        this._pendingFreezeSegments = []; // Segments waiting to be batch-frozen into geometry
        this._resizeHandler = null; // Stored so we don't leak listeners

        // Print interaction (click-to-remove after print completes)
        this.printObserver = null;
        this.removePopup = null;
        this.highlightedMesh = null;
        this.onPrintRemoved = null;

        this.initScene();
        this.startRenderLoop();
    }

    /**
     * Initialize Babylon.js scene
     */
    initScene() {
        this.scene = new BABYLON.Scene(this.engine);
        this.scene.clearColor = new BABYLON.Color3(0.1, 0.1, 0.18);

        // Camera
        this.camera = new BABYLON.ArcRotateCamera(
            "camera",
            -Math.PI / 2,
            Math.PI / 3,
            150,
            new BABYLON.Vector3(0, 0, 0),
            this.scene
        );
        this.camera.attachControl(this.canvas, true);
        this.camera.wheelPrecision = 2; // IMPROVED: Much faster zoom (was 5, now 2)
        this.camera.lowerRadiusLimit = 20;
        this.camera.upperRadiusLimit = 500;

        // Enable right-click panning
        this.camera.panningSensibility = 50; // Lower = faster panning
        this.camera.panningAxis = new BABYLON.Vector3(1, 1, 0); // Pan in X and Y
        this.camera.panningInertia = 0.7; // Smooth panning

        // Lighting - optimized to show layer lines without harsh diagonal shadows
        // Use only hemispheric light pointing straight down for even top-lighting
        this.mainLight = new BABYLON.HemisphericLight(
            "light1",
            new BABYLON.Vector3(0, 1, 0), // Straight down
            this.scene
        );
        this.mainLight.intensity = 0.6; // Lower intensity for better layer visibility
        // Lower ground color creates more contrast to show layer detail
        this.mainLight.groundColor = new BABYLON.Color3(0.3, 0.3, 0.3);
        this.mainLight.diffuse = new BABYLON.Color3(1, 1, 1);
        this.mainLight.specular = new BABYLON.Color3(0, 0, 0); // No specular

        // Store default lighting settings - "Layers" preset for best layer visibility
        this.lightingSettings = {
            brightness: 0.6,
            shadowSoftness: 0.3,
            detailLevel: 0.5  // Higher = more layer detail visible (emissive = 1 - detailLevel)
        };

        // Build Plate
        this.createBuildPlate(200, 200);

        // Print Head
        this.createPrintHead();

        // Grid helper
        const grid = BABYLON.MeshBuilder.CreateGround("grid", {
            width: 220,
            height: 220,
            subdivisions: 22
        }, this.scene);
        grid.position.y = -0.1;
        grid.isPickable = false; // Don't allow selecting grid
        const gridMaterial = new BABYLON.GridMaterial("gridMaterial", this.scene);
        gridMaterial.majorUnitFrequency = 10;
        gridMaterial.minorUnitVisibility = 0.3;
        gridMaterial.gridRatio = 10;
        gridMaterial.backFaceCulling = false;
        gridMaterial.mainColor = new BABYLON.Color3(0.2, 0.2, 0.3);
        gridMaterial.lineColor = new BABYLON.Color3(0.4, 0.4, 0.5);
        gridMaterial.opacity = 0.8;
        grid.material = gridMaterial;
    }

    /**
     * Create build plate mesh
     */
    createBuildPlate(width, depth) {
        this.buildPlate = BABYLON.MeshBuilder.CreateBox("buildPlate", {
            width: width,
            height: 2,
            depth: depth
        }, this.scene);
        this.buildPlate.position.y = -1;
        this.buildPlate.isPickable = false; // Don't allow selecting build plate

        const material = new BABYLON.StandardMaterial("buildPlateMaterial", this.scene);
        material.diffuseColor = new BABYLON.Color3(0.3, 0.3, 0.35);
        material.specularColor = new BABYLON.Color3(0.1, 0.1, 0.1);
        this.buildPlate.material = material;
    }

    /**
     * Create print head mesh with realistic printer frame
     */
    createPrintHead() {
        // Main printer frame assembly
        const printerFrame = new BABYLON.TransformNode("printerFrame", this.scene);

        // Materials
        const frameMaterial = new BABYLON.StandardMaterial("frameMaterial", this.scene);
        frameMaterial.diffuseColor = new BABYLON.Color3(0.2, 0.2, 0.22); // Dark gray aluminum
        frameMaterial.specularColor = new BABYLON.Color3(0.3, 0.3, 0.3);

        const railMaterial = new BABYLON.StandardMaterial("railMaterial", this.scene);
        railMaterial.diffuseColor = new BABYLON.Color3(0.5, 0.5, 0.52); // Lighter metal
        railMaterial.specularColor = new BABYLON.Color3(0.5, 0.5, 0.5);

        const beltMaterial = new BABYLON.StandardMaterial("beltMaterial", this.scene);
        beltMaterial.diffuseColor = new BABYLON.Color3(0.1, 0.1, 0.1); // Black rubber

        const motorMaterial = new BABYLON.StandardMaterial("motorMaterial", this.scene);
        motorMaterial.diffuseColor = new BABYLON.Color3(0.15, 0.15, 0.16); // Dark stepper motor

        // Frame dimensions (matching build plate size)
        const frameHeight = 250;
        const frameWidth = 220;
        const frameDepth = 220;
        const postSize = 2;

        // Create 4 vertical corner posts
        const posts = [
            { x: -frameWidth/2, z: -frameDepth/2 },
            { x: frameWidth/2, z: -frameDepth/2 },
            { x: -frameWidth/2, z: frameDepth/2 },
            { x: frameWidth/2, z: frameDepth/2 }
        ];

        posts.forEach((pos, i) => {
            const post = BABYLON.MeshBuilder.CreateBox(`post${i}`, {
                width: postSize,
                height: frameHeight,
                depth: postSize
            }, this.scene);
            post.position = new BABYLON.Vector3(pos.x, frameHeight/2, pos.z);
            post.material = frameMaterial;
            post.parent = printerFrame;
            post.isPickable = false;
        });

        // Top horizontal frame bars
        const topBar1 = BABYLON.MeshBuilder.CreateBox("topBar1", {
            width: frameWidth,
            height: postSize,
            depth: postSize
        }, this.scene);
        topBar1.position = new BABYLON.Vector3(0, frameHeight, -frameDepth/2);
        topBar1.material = frameMaterial;
        topBar1.parent = printerFrame;
        topBar1.isPickable = false;

        const topBar2 = BABYLON.MeshBuilder.CreateBox("topBar2", {
            width: frameWidth,
            height: postSize,
            depth: postSize
        }, this.scene);
        topBar2.position = new BABYLON.Vector3(0, frameHeight, frameDepth/2);
        topBar2.material = frameMaterial;
        topBar2.parent = printerFrame;
        topBar2.isPickable = false;

        // Moving gantry assembly (this whole thing moves up/down for Z-axis)
        this.xGantry = new BABYLON.TransformNode("xGantry", this.scene);
        this.xGantry.parent = printerFrame;

        // Y-axis support arms (vertical rails on each side - extend UP from the rail)
        const yArmLeft = BABYLON.MeshBuilder.CreateBox("yArmLeft", {
            width: 2,
            height: 10,
            depth: 2
        }, this.scene);
        yArmLeft.position = new BABYLON.Vector3(-frameWidth/2 + 5, 5, 0); // Positioned above rail
        yArmLeft.material = railMaterial;
        yArmLeft.parent = this.xGantry;
        yArmLeft.isPickable = false;
        yArmLeft.renderingGroupId = 2; // Render on top of print

        const yArmRight = BABYLON.MeshBuilder.CreateBox("yArmRight", {
            width: 2,
            height: 10,
            depth: 2
        }, this.scene);
        yArmRight.position = new BABYLON.Vector3(frameWidth/2 - 5, 5, 0); // Positioned above rail
        yArmRight.material = railMaterial;
        yArmRight.parent = this.xGantry;
        yArmRight.isPickable = false;
        yArmRight.renderingGroupId = 2; // Render on top of print

        // X-axis rail (horizontal, mounted on the Y-arms)
        const xRail = BABYLON.MeshBuilder.CreateBox("xRail", {
            width: frameWidth - 10,
            height: 1.5,
            depth: 1.5
        }, this.scene);
        xRail.position = new BABYLON.Vector3(0, 0, 0);
        xRail.material = railMaterial;
        xRail.parent = this.xGantry;
        xRail.isPickable = false;
        xRail.renderingGroupId = 2; // Render on top of print

        // X-axis belt
        const xBelt = BABYLON.MeshBuilder.CreateBox("xBelt", {
            width: frameWidth - 10,
            height: 0.5,
            depth: 0.5
        }, this.scene);
        xBelt.position = new BABYLON.Vector3(0, 0, -2);
        xBelt.material = beltMaterial;
        xBelt.parent = this.xGantry;
        xBelt.isPickable = false;
        xBelt.renderingGroupId = 2; // Render on top of print

        // X-axis stepper motors
        const motorSize = 3;
        const xMotor1 = BABYLON.MeshBuilder.CreateBox("xMotor1", {
            width: motorSize,
            height: motorSize,
            depth: motorSize
        }, this.scene);
        xMotor1.position = new BABYLON.Vector3(-frameWidth/2 + 5, 0, 0);
        xMotor1.material = motorMaterial;
        xMotor1.parent = this.xGantry;
        xMotor1.isPickable = false;
        xMotor1.renderingGroupId = 2; // Render on top of print

        const xMotor2 = BABYLON.MeshBuilder.CreateBox("xMotor2", {
            width: motorSize,
            height: motorSize,
            depth: motorSize
        }, this.scene);
        xMotor2.position = new BABYLON.Vector3(frameWidth/2 - 5, 0, 0);
        xMotor2.material = motorMaterial;
        xMotor2.parent = this.xGantry;
        xMotor2.isPickable = false;
        xMotor2.renderingGroupId = 2; // Render on top of print

        // Print head carriage (moves along X-axis rail)
        const headGroup = new BABYLON.TransformNode("printHead", this.scene);
        headGroup.parent = this.xGantry;

        // Carriage block (sits ON TOP of the rail)
        const carriage = BABYLON.MeshBuilder.CreateBox("carriage", {
            width: 8,
            height: 2,
            depth: 6
        }, this.scene);
        carriage.position.y = 1; // Sits on top of rail (rail is at Y=0)
        carriage.material = frameMaterial;
        carriage.parent = headGroup;
        carriage.isPickable = false;
        carriage.renderingGroupId = 2; // Render on top of print

        // Hotend mount (hangs BELOW carriage)
        const block = BABYLON.MeshBuilder.CreateBox("headBlock", {
            width: 6,
            height: 4,
            depth: 6
        }, this.scene);
        block.position.y = -2; // Below the rail
        block.parent = headGroup;
        block.isPickable = false;

        // Hot end (hangs BELOW mount)
        const hotend = BABYLON.MeshBuilder.CreateCylinder("hotend", {
            height: 4,
            diameterTop: 3,
            diameterBottom: 1
        }, this.scene);
        hotend.position.y = -6; // Below mount
        hotend.parent = headGroup;
        hotend.isPickable = false;

        // Nozzle (at the tip, BELOW everything)
        const nozzle = BABYLON.MeshBuilder.CreateCylinder("nozzle", {
            height: 1,
            diameterTop: 1,
            diameterBottom: 0.2
        }, this.scene);
        nozzle.position.y = -8.5; // Nozzle tip
        nozzle.parent = headGroup;
        nozzle.isPickable = false;

        // Cooling fan (on side of hotend)
        const fan = BABYLON.MeshBuilder.CreateBox("fan", {
            width: 4,
            height: 4,
            depth: 1
        }, this.scene);
        fan.position = new BABYLON.Vector3(-4, -2, 0); // Level with hotend mount
        fan.material = frameMaterial;
        fan.parent = headGroup;
        fan.isPickable = false;
        fan.renderingGroupId = 2; // Render on top of print

        // Extruder motor (on top of carriage, ABOVE rail)
        const extruderMotor = BABYLON.MeshBuilder.CreateBox("extruderMotor", {
            width: 3,
            height: 3,
            depth: 3
        }, this.scene);
        extruderMotor.position = new BABYLON.Vector3(0, 2.5, 4); // On top of carriage
        extruderMotor.material = motorMaterial;
        extruderMotor.parent = headGroup;
        extruderMotor.isPickable = false;
        extruderMotor.renderingGroupId = 2; // Render on top of print

        // Material for hotend
        const headMaterial = new BABYLON.StandardMaterial("headMaterial", this.scene);
        headMaterial.diffuseColor = new BABYLON.Color3(0.7, 0.3, 0.3);
        headMaterial.emissiveColor = new BABYLON.Color3(0.2, 0.1, 0.1);
        block.material = headMaterial;
        hotend.material = headMaterial;
        nozzle.material = headMaterial;

        // Store material reference for retraction indicator
        this.printHeadMaterial = headMaterial;

        // Set rendering group to render on top of print
        block.renderingGroupId = 2;
        hotend.renderingGroupId = 2;
        nozzle.renderingGroupId = 2;

        // Start position - nozzle at build plate level
        headGroup.position = new BABYLON.Vector3(0, 0, 0);
        this.xGantry.position = new BABYLON.Vector3(0, 8.5, 0); // Nozzle is 8.5 units below rail, so gantry at 8.5 puts nozzle at Y=0
        this.printHead = headGroup;
        this.isRetracted = false;
    }

    /**
     * Load G-code commands
     */
    loadCommands(commands) {
        this.commands = commands.filter(cmd => cmd.type === 'move');
        this.currentCommandIndex = 0;
        this.clearPrint();

        // Lock the color at load time to prevent mid-print color changes
        this.lockedPrintColor = this.filamentColor.clone();

        // Move print head to starting position of first EXTRUDING move
        if (this.commands.length > 0 && this.printHead && this.xGantry) {
            // Find first extruding command (skip initial travel moves)
            const firstExtrudingCmd = this.commands.find(cmd => cmd.extruding);
            const firstCmd = firstExtrudingCmd || this.commands[0];

            const startPos = new BABYLON.Vector3(
                firstCmd.from.x,
                firstCmd.from.z,
                firstCmd.from.y
            );

            // Position print head at starting location
            this.printHead.position.x = startPos.x;
            this.xGantry.position.z = startPos.z;
            this.xGantry.position.y = startPos.y + 8.5;
        }

        // Center camera on print
        if (this.commands.length > 0) {
            const parser = new GCodeParser();
            parser.commands = commands;
            const bbox = parser.getBoundingBox();
            const center = new BABYLON.Vector3(
                (bbox.min.x + bbox.max.x) / 2,
                (bbox.min.z + bbox.max.z) / 2,
                (bbox.min.y + bbox.max.y) / 2
            );
            this.camera.target = center;
        }
    }

    /**
     * Clear all printed geometry
     */
    clearPrint() {
        // Clean up print interaction if active
        this.disablePrintInteraction();

        // Dispose single line mesh
        if (this.lineMesh) {
            this.lineMesh.dispose();
            this.lineMesh = null;
        }

        // Dispose frozen meshes and their materials
        if (this.frozenMeshes) {
            this.frozenMeshes.forEach(mesh => {
                if (mesh.material && mesh.material !== this.frozenMaterial) {
                    mesh.material.dispose();
                }
                mesh.dispose();
            });
            this.frozenMeshes = [];
        }

        // Dispose print material
        if (this.printMaterial) {
            this.printMaterial.dispose();
            this.printMaterial = null;
        }

        this.printedGeometry.forEach(mesh => {
            if (mesh.material) {
                mesh.material.dispose();
            }
            mesh.dispose();
        });
        this.printedGeometry = [];

        this.pathLines.forEach(line => line.dispose());
        this.pathLines = [];

        this.mergedMeshes.forEach(mesh => {
            if (mesh.material) {
                mesh.material.dispose();
            }
            mesh.dispose();
        });
        this.mergedMeshes = [];

        this.allPoints = [];
        this.pathSegments = [];
        this.allPathSegments = []; // Clear permanent segment storage too
        this.currentSegment = [];
        this.updateCounter = 0;
        this.totalPointCount = 0; // Reset running point counter
        this._pendingFreezeSegments = []; // Clear pending freeze queue
        this.lockedPrintColor = null; // Unlock color when clearing

        // Dispose cached materials
        if (this.frozenMaterial) {
            this.frozenMaterial.dispose();
            this.frozenMaterial = null;
        }
        if (this.activeMaterial) {
            this.activeMaterial.dispose();
            this.activeMaterial = null;
        }

        // Don't reset print head position here - it will be set correctly in loadCommands() or play()
    }

    /**
     * Start printing animation
     */
    play() {
        this.isPlaying = true;
        this.lastFrameTime = 0; // Reset timing
        this.frameAccumulator = 0;

        // Move print head to starting position of first EXTRUDING command
        if (this.commands.length > 0 && this.printHead && this.xGantry) {
            // Find first extruding command (skip initial travel moves)
            const firstExtrudingCmd = this.commands.find(cmd => cmd.extruding);
            const firstCmd = firstExtrudingCmd || this.commands[0];

            const startPos = new BABYLON.Vector3(
                firstCmd.from.x,
                firstCmd.from.z,
                firstCmd.from.y
            );

            // Position print head at starting location
            this.printHead.position.x = startPos.x;
            this.xGantry.position.z = startPos.z;
            this.xGantry.position.y = startPos.y + 8.5;
        }

        this.animate();
    }

    /**
     * Pause printing animation
     */
    pause() {
        this.isPlaying = false;
        this.lastFrameTime = 0; // Reset timing for next play
    }

    /**
     * Reset printer to start
     */
    reset() {
        this.pause();
        this.currentCommandIndex = 0;
        this.frameAccumulator = 0;
        this.lastFrameTime = 0;
        this.clearPrint();
        this.resetTemperature();
    }

    /**
     * Animation loop for printing
     */
    animate() {
        if (!this.isPlaying || this.currentCommandIndex >= this.commands.length) {
            if (this.currentCommandIndex >= this.commands.length) {
                this.isPlaying = false;
                // Freeze final segment and flush all pending geometry
                if (this.currentSegment.length > 1) {
                    this.freezeSegment();
                }
                this._flushPendingFreezes();
                // Merge frozen meshes for final result (fewer draw calls)
                this.mergeFrozenMeshes();
                this.enablePrintInteraction();
                this.onComplete && this.onComplete();
            }
            return;
        }

        // Calculate delta time
        const currentTime = performance.now();
        if (this.lastFrameTime === 0) {
            this.lastFrameTime = currentTime;
        }
        const deltaTime = (currentTime - this.lastFrameTime) / 1000; // Convert to seconds
        this.lastFrameTime = currentTime;

        // Enable smooth interpolation at slow-medium speeds for realistic appearance
        const newInterpolationMode = this.speed <= 30;

        // If we're switching modes, reset interpolation state
        if (this.useInterpolation !== newInterpolationMode) {
            this.commandProgress = 0;
            this.lastInterpolatedPosition = null;
            this.frameAccumulator = 0; // Reset batch accumulator too

            // If switching TO interpolation mode, ensure we're at a command boundary
            if (newInterpolationMode && this.currentCommandIndex < this.commands.length) {
                // Get current command's starting position for clean interpolation start
                const cmd = this.commands[this.currentCommandIndex];
                if (cmd && cmd.type === 'move') {
                    this.lastInterpolatedPosition = new BABYLON.Vector3(
                        cmd.from.x,
                        cmd.from.z,
                        cmd.from.y
                    );
                }
            }
        }
        this.useInterpolation = newInterpolationMode;

        if (this.useInterpolation && this.currentCommandIndex < this.commands.length) {
            // INTERPOLATION MODE: Smooth movement through commands
            const command = this.commands[this.currentCommandIndex];

            // Progress through current command based on speed
            const progressPerSecond = 10 * this.speed; // Commands per second
            const progressIncrement = progressPerSecond * deltaTime;

            this.commandProgress += progressIncrement;

            if (this.commandProgress >= 1.0) {
                // Command complete - execute it normally and move to next
                this.executeCommand(command);

                if (command.type === 'move') {
                    const to = new BABYLON.Vector3(
                        command.to.x,
                        command.to.z,
                        command.to.y
                    );

                    // Complete the final segment if we were extruding
                    if (command.extruding && this.lastInterpolatedPosition) {
                        const distance = BABYLON.Vector3.Distance(this.lastInterpolatedPosition, to);
                        if (distance > 0.001) {
                            // Add final segment to exact end point
                            if (this.currentSegment.length === 0) {
                                this.currentSegment.push(this.lastInterpolatedPosition.clone());
                            }
                            this.currentSegment.push(to.clone());
                        }
                    }

                    // Ensure print head is at final position
                    if (this.printHead && this.xGantry) {
                        this.printHead.position.x = to.x;
                        this.xGantry.position.z = to.z;
                        this.xGantry.position.y = to.y + 8.5;
                    }

                    // Handle segment breaks for travel moves
                    if (!command.extruding && this.currentSegment.length > 1) {
                        this.freezeSegment();
                    }
                }

                this.currentCommandIndex++;
                this.commandProgress = 0;
                this.lastInterpolatedPosition = null; // Reset for next command

                // Merge layers periodically for performance
                const currentLayer = command?.layer || 0;
                if (currentLayer > 0 && currentLayer % this.layerMergeInterval === 0) {
                    this.mergeLayers(currentLayer - this.layerMergeInterval, currentLayer);
                }
            } else if (command.type === 'move') {
                // Partially execute - move print head and show partial extrusion
                this.executeCommandPartial(command, this.commandProgress);
            }
        } else {
            // FAST MODE: Batch command execution
            // Accumulate progress based on speed and delta time
            const commandsPerSecond = 10 * this.speed;
            this.frameAccumulator += commandsPerSecond * deltaTime;

            // Cap the accumulator to prevent huge backlogs
            const maxAccumulator = 1000;
            if (this.frameAccumulator > maxAccumulator) {
                this.frameAccumulator = maxAccumulator;
            }

            // Process accumulated commands
            let commandsToProcess = Math.floor(this.frameAccumulator);
            this.frameAccumulator -= commandsToProcess;

            for (let i = 0; i < commandsToProcess && this.currentCommandIndex < this.commands.length; i++) {
                this.executeCommand(this.commands[this.currentCommandIndex]);
                this.currentCommandIndex++;

                // Merge layers periodically for performance
                const currentLayer = this.commands[this.currentCommandIndex - 1]?.layer || 0;
                if (currentLayer > 0 && currentLayer % this.layerMergeInterval === 0) {
                    this.mergeLayers(currentLayer - this.layerMergeInterval, currentLayer);
                }
            }
        }

        // Simulate temperature fluctuation during printing (realistic PID controller behavior)
        if (this.isPlaying && !this.isHeating) {
            this.fluctuateTemperatures();
        }

        // Update progress callback (every frame for smooth UI updates)
        if (this.onProgress && this.currentCommandIndex > 0) {
            const cmd = this.commands[this.currentCommandIndex - 1] || {};
            this.onProgress({
                commandIndex: this.currentCommandIndex,
                totalCommands: this.commands.length,
                layer: cmd.layer || 0,
                position: cmd.to || { x: 0, y: 0, z: 0 },
                extruding: cmd.extruding || false,
                retracting: this.isRetracted || false
            });
        }

        // Update geometry once per frame (not per command)
        this.updateLineMesh();
        this._flushPendingFreezes();

        // Continue animation
        requestAnimationFrame(() => this.animate());
    }

    /**
     * Execute a command partially (for smooth interpolation at slow speeds)
     */
    executeCommandPartial(command, progress) {
        if (command.type !== 'move') return;

        // Convert G-code coordinates to Babylon.js coordinates
        const from = new BABYLON.Vector3(
            command.from.x,
            command.from.z,
            command.from.y
        );
        const to = new BABYLON.Vector3(
            command.to.x,
            command.to.z,
            command.to.y
        );

        // Interpolate position
        const currentPos = BABYLON.Vector3.Lerp(from, to, progress);

        // Move print head smoothly
        if (this.printHead && this.xGantry) {
            this.printHead.position.x = currentPos.x;
            this.xGantry.position.z = currentPos.z;
            this.xGantry.position.y = currentPos.y + 8.5;
        }

        // Show partial extrusion if extruding
        if (command.extruding) {
            // Update retraction indicator
            if (this.printHeadMaterial && this.isRetracted) {
                this.printHeadMaterial.emissiveColor = new BABYLON.Color3(0.2, 0.1, 0.1);
                this.isRetracted = false;
            }

            // Add incremental line segment (only the new portion since last update)
            if (this.useLineRendering && progress > 0.01) { // Start showing at 1% progress
                // Use last position or start of command
                const segmentFrom = this.lastInterpolatedPosition || from;
                const segmentTo = currentPos.clone();

                // Only add if there's actual movement
                const distance = BABYLON.Vector3.Distance(segmentFrom, segmentTo);

                if (distance > 0.005) { // Very small threshold for smooth appearance
                    // If starting a new segment, add the starting point
                    if (this.currentSegment.length === 0) {
                        this.currentSegment.push(segmentFrom.clone());
                        this.totalPointCount++;
                    }
                    // Add the current position
                    this.currentSegment.push(segmentTo);
                    this.totalPointCount++;

                    // Track this position for next frame
                    this.lastInterpolatedPosition = segmentTo;
                }
            }
        } else {
            // Travel move - show retraction indicator
            if (this.printHeadMaterial && !this.isRetracted) {
                this.printHeadMaterial.emissiveColor = new BABYLON.Color3(0.2, 0.5, 1.0);
                this.isRetracted = true;
            }
            // Reset interpolation position for travel moves
            this.lastInterpolatedPosition = null;
        }
    }

    /**
     * Execute a single G-code command
     */
    executeCommand(command) {
        if (command.type !== 'move') return;

        // Convert G-code coordinates to Babylon.js coordinates
        // G-code: X=right, Y=back, Z=up
        // Babylon: X=right, Y=up, Z=back
        const from = new BABYLON.Vector3(
            command.from.x,
            command.from.z,
            command.from.y
        );
        const to = new BABYLON.Vector3(
            command.to.x,
            command.to.z,
            command.to.y
        );

        // Move gantry and print head to simulate real printer mechanics
        if (this.printHead && this.xGantry) {
            // X-axis: Print head carriage moves left/right along the X-rail
            this.printHead.position.x = to.x;

            // Y-axis: Entire gantry assembly moves forward/back
            this.xGantry.position.z = to.z;

            // Z-axis: Entire gantry assembly moves up/down
            // Nozzle is 8.5 units below the gantry rail, so add 8.5 to keep nozzle at correct height
            this.xGantry.position.y = to.y + 8.5;
        }

        // Only create geometry when extruding
        if (command.extruding) {
            // Extruding - show normal print head color
            if (this.printHeadMaterial && this.isRetracted) {
                this.printHeadMaterial.emissiveColor = new BABYLON.Color3(0.2, 0.1, 0.1); // Normal red glow
                this.isRetracted = false;
            }

            if (this.useLineRendering) {
                // For line rendering, add to current segment
                this.addLineSegment(from, to, command.layer, true);
            } else {
                // For cylinder rendering
                this.createExtrusionGeometry(from, to, command.layer);
            }
        } else {
            // Travel move - retract and show visual indicator
            if (this.printHeadMaterial && !this.isRetracted) {
                this.printHeadMaterial.emissiveColor = new BABYLON.Color3(0.2, 0.5, 1.0); // Blue glow for retraction
                this.isRetracted = true;
            }

            // Break the current segment - freeze it as static geometry
            if (this.useLineRendering && this.currentSegment.length > 1) {
                if (this.isQuickPrinting) {
                    // During quick print, just save segment data (no geometry)
                    this.allPathSegments.push([...this.currentSegment]);
                    this.currentSegment = [];
                } else {
                    this.freezeSegment();
                }
            }
        }
    }

    /**
     * Create geometry for extruded filament
     */
    createExtrusionGeometry(from, to, layer, isExtruding = true) {
        const distance = BABYLON.Vector3.Distance(from, to);
        if (distance < 0.01) return; // Skip tiny movements

        // Skip some segments based on simplification level
        if (this.simplificationLevel > 1.0 && Math.random() > (1.0 / this.simplificationLevel)) {
            return;
        }

        if (this.useLineRendering) {
            // FAST: Use line rendering (batched)
            this.addLineSegment(from, to, layer, isExtruding);
        } else {
            // SLOW: Use cylinder meshes (original method)
            this.createCylinderGeometry(from, to, layer);
        }
    }

    /**
     * Add line segment — just collects point data, no geometry creation.
     * Geometry is created once per frame in animate() via updateLineMesh().
     */
    addLineSegment(from, to, layer) {
        // If starting a new segment (after travel move), add the starting point
        if (this.currentSegment.length === 0) {
            this.currentSegment.push(from.clone());
            this.totalPointCount++;
        }
        // Add the end point to continue the segment
        this.currentSegment.push(to.clone());
        this.totalPointCount++;
    }

    /**
     * Freeze old geometry into a static mesh
     * Takes the oldest segments, creates a permanent mesh, then removes them from active segments
     * OPTIMIZED: More aggressive freezing with simpler geometry
     */
    freezeOldGeometry() {
        if (this.pathSegments.length <= this.maxActiveSegments) return;

        // OPTIMIZATION: Freeze more segments at once to reduce frozen mesh count
        const segmentsToFreeze = Math.max(
            this.pathSegments.length - this.maxActiveSegments,
            Math.floor(this.maxActiveSegments / 2) // Freeze at least half of max at a time
        );

        // Take the oldest segments
        const oldSegments = this.pathSegments.splice(0, segmentsToFreeze);

        // Decrement total point count for spliced segments
        for (const seg of oldSegments) {
            this.totalPointCount -= seg.length;
        }

        // OPTIMIZATION: Always use lowest tessellation for frozen geometry
        // Users won't notice the difference on completed geometry
        const tessellation = 3; // Triangle - simplest and fastest
        const radius = this.lineThickness / 2;

        // Create a CLONED material for frozen geometry to prevent color changes
        // This ensures frozen geometry keeps its color even if printMaterial changes later
        const frozenMaterial = new BABYLON.StandardMaterial(`frozen_material_${this.frozenMeshes.length}`, this.scene);
        const baseColor = this.printMaterial.diffuseColor.clone();
        frozenMaterial.diffuseColor = baseColor;
        // Use emissive from lighting settings for better layer visibility
        const emissiveStrength = 1 - this.lightingSettings.detailLevel;
        frozenMaterial.emissiveColor = new BABYLON.Color3(
            baseColor.r * emissiveStrength,
            baseColor.g * emissiveStrength,
            baseColor.b * emissiveStrength
        );
        frozenMaterial.specularColor = new BABYLON.Color3(0, 0, 0);
        frozenMaterial.backFaceCulling = false;
        frozenMaterial.freeze();

        // Create tubes for these segments
        const tubeMeshes = [];
        for (let i = 0; i < oldSegments.length; i++) {
            const segment = oldSegments[i];
            if (segment.length < 2) continue;

            const tube = BABYLON.MeshBuilder.CreateTube(`frozen_segment_${this.frozenMeshes.length}_${i}`, {
                path: segment,
                radius: radius,
                tessellation: tessellation,
                cap: BABYLON.Mesh.NO_CAP,
                updatable: false
            }, this.scene);

            tube.material = frozenMaterial; // Use cloned material instead of shared one
            tubeMeshes.push(tube);
        }

        // Merge into a single frozen mesh
        if (tubeMeshes.length > 0) {
            const frozenMesh = BABYLON.Mesh.MergeMeshes(
                tubeMeshes,
                true,  // disposeSource
                true,  // allow32BitsIndices
                undefined,
                false,
                true
            );

            if (frozenMesh) {
                frozenMesh.renderingGroupId = 1;
                frozenMesh.isPickable = false; // Don't allow selecting printed geometry
                frozenMesh.freezeWorldMatrix(); // Optimize - this geometry won't move

                // OPTIMIZATION: If we have too many frozen meshes, merge them together
                this.frozenMeshes.push(frozenMesh);

                if (this.frozenMeshes.length > 10) {
                    this.mergeFrozenMeshes();
                }
            }
        }
    }

    /**
     * Merge multiple frozen meshes into fewer meshes
     * OPTIMIZATION: Reduce draw calls by consolidating frozen geometry
     */
    mergeFrozenMeshes() {
        if (this.frozenMeshes.length <= 5) return;

        // Merge all frozen meshes into one
        const superMesh = BABYLON.Mesh.MergeMeshes(
            this.frozenMeshes,
            true,  // disposeSource
            true,  // allow32BitsIndices
            undefined,
            false,
            true
        );

        if (superMesh) {
            superMesh.renderingGroupId = 1;
            superMesh.isPickable = false;
            superMesh.freezeWorldMatrix();

            // Replace all frozen meshes with the single merged one
            this.frozenMeshes = [superMesh];
        }
    }

    /**
     * Mark the current segment as complete — saves its path data for later
     * batch-freezing. No geometry is created here; that happens in
     * _flushPendingFreezes() once per animation frame.
     */
    freezeSegment() {
        if (this.currentSegment.length < 2) return;

        const segmentCopy = [...this.currentSegment];
        this.allPathSegments.push(segmentCopy);
        this._pendingFreezeSegments.push(segmentCopy);

        // Dispose stale active mesh (it still shows the old currentSegment data)
        if (this.lineMesh) {
            this.lineMesh.dispose();
            this.lineMesh = null;
        }

        // Reset current segment
        this.currentSegment = [];
    }

    /**
     * Batch-create frozen tube geometry from all pending segments.
     * Called once per animation frame to amortize CreateTube cost.
     */
    _flushPendingFreezes() {
        if (this._pendingFreezeSegments.length === 0) return;

        const radius = this.lineThickness / 2;
        const colorToUse = this.lockedPrintColor || this.filamentColor;
        const emissiveStrength = 1 - this.lightingSettings.detailLevel;

        // Ensure shared frozen material exists (non-rainbow)
        if (!this.rainbowMode && !this.frozenMaterial) {
            this.frozenMaterial = new BABYLON.StandardMaterial("frozenPrintMaterial", this.scene);
            this.frozenMaterial.diffuseColor = colorToUse.clone();
            this.frozenMaterial.emissiveColor = new BABYLON.Color3(
                colorToUse.r * emissiveStrength,
                colorToUse.g * emissiveStrength,
                colorToUse.b * emissiveStrength
            );
            this.frozenMaterial.specularColor = new BABYLON.Color3(0, 0, 0);
            this.frozenMaterial.backFaceCulling = false;
            this.frozenMaterial.freeze();
        }

        // Create tubes for all pending segments in one batch
        const tubeMeshes = [];
        for (let i = 0; i < this._pendingFreezeSegments.length; i++) {
            const segment = this._pendingFreezeSegments[i];
            if (segment.length < 2) continue;

            let material;
            if (this.rainbowMode) {
                const currentLayer = Math.floor((this.frozenMeshes.length + i) * 3);
                const layerColor = this.getLayerColor(currentLayer);
                material = new BABYLON.StandardMaterial(`frozen_rainbow_${this.frozenMeshes.length + i}`, this.scene);
                material.diffuseColor = layerColor;
                material.emissiveColor = new BABYLON.Color3(
                    layerColor.r * emissiveStrength,
                    layerColor.g * emissiveStrength,
                    layerColor.b * emissiveStrength
                );
                material.specularColor = new BABYLON.Color3(0, 0, 0);
                material.backFaceCulling = false;
                material.freeze();
            } else {
                material = this.frozenMaterial;
            }

            try {
                const tube = BABYLON.MeshBuilder.CreateTube(`frozen_seg_${this.frozenMeshes.length + i}`, {
                    path: segment,
                    radius: radius,
                    tessellation: 3,
                    cap: BABYLON.Mesh.NO_CAP,
                    updatable: false
                }, this.scene);
                tube.material = material;
                tubeMeshes.push(tube);
            } catch (e) {
                // Skip invalid segments
            }
        }

        this._pendingFreezeSegments = [];

        // Merge the batch into one frozen mesh (single draw call)
        if (tubeMeshes.length > 0) {
            let batchMesh;
            if (tubeMeshes.length === 1) {
                batchMesh = tubeMeshes[0];
            } else {
                batchMesh = BABYLON.Mesh.MergeMeshes(tubeMeshes, true, true, undefined, false, true);
            }
            if (batchMesh) {
                batchMesh.renderingGroupId = 1;
                batchMesh.isPickable = false;
                batchMesh.freezeWorldMatrix();
                this.frozenMeshes.push(batchMesh);

                // Consolidate all frozen meshes periodically
                if (this.frozenMeshes.length > 10) {
                    this.mergeFrozenMeshes();
                }
            }
        }
    }

    /**
     * Update the active segment mesh (current in-progress segment only)
     * O(1) cost regardless of print complexity
     */
    updateLineMesh() {
        // Only render the current in-progress segment
        if (this.currentSegment.length < 2) return;

        // Dispose old active mesh
        if (this.lineMesh) {
            this.lineMesh.dispose();
            this.lineMesh = null;
        }

        const radius = this.lineThickness / 2;
        const colorToUse = this.lockedPrintColor || this.filamentColor;
        const emissiveStrength = 1 - this.lightingSettings.detailLevel;

        // Create or reuse the active material
        if (!this.activeMaterial) {
            this.activeMaterial = new BABYLON.StandardMaterial("activePrintMaterial", this.scene);
            this.activeMaterial.specularColor = new BABYLON.Color3(0, 0, 0);
            this.activeMaterial.backFaceCulling = false;
        }

        // Update color on the cached material
        if (this.rainbowMode) {
            const currentLayer = Math.floor(this.totalPointCount / 100);
            const layerColor = this.getLayerColor(currentLayer);
            this.activeMaterial.diffuseColor = layerColor;
            this.activeMaterial.emissiveColor = new BABYLON.Color3(
                layerColor.r * emissiveStrength,
                layerColor.g * emissiveStrength,
                layerColor.b * emissiveStrength
            );
        } else {
            this.activeMaterial.diffuseColor = colorToUse.clone();
            this.activeMaterial.emissiveColor = new BABYLON.Color3(
                colorToUse.r * emissiveStrength,
                colorToUse.g * emissiveStrength,
                colorToUse.b * emissiveStrength
            );
        }

        // Create a single tube for the current segment only — O(1)
        try {
            this.lineMesh = BABYLON.MeshBuilder.CreateTube("active_segment", {
                path: this.currentSegment,
                radius: radius,
                tessellation: 3,
                cap: BABYLON.Mesh.NO_CAP,
                updatable: false
            }, this.scene);

            this.lineMesh.material = this.activeMaterial;
            this.lineMesh.renderingGroupId = 1;
            this.lineMesh.isPickable = false;
        } catch (e) {
            // Skip invalid segments
        }
    }

    /**
     * Perform final high-quality render after print completes
     * This re-renders all geometry with higher tessellation and capped ends
     * to match the preview quality and give a more realistic printed look
     */
    finalQualityRender(lightweight) {
        // Use allPathSegments which contains ALL segments (not cleared during freezing)
        const allSegments = [...this.allPathSegments];
        // Also add current segment if it has points
        if (this.currentSegment.length > 1) {
            allSegments.push([...this.currentSegment]);
        }

        if (allSegments.length === 0) return;

        // Dispose existing geometry
        if (this.lineMesh) {
            if (this.lineMesh.material && this.lineMesh.material !== this.printMaterial) {
                this.lineMesh.material.dispose();
            }
            this.lineMesh.dispose();
            this.lineMesh = null;
        }

        // Dispose frozen meshes
        this.frozenMeshes.forEach(mesh => {
            if (mesh) {
                if (mesh.material) mesh.material.dispose();
                mesh.dispose();
            }
        });
        this.frozenMeshes = [];

        // Use locked color or current filament color
        const colorToUse = this.lockedPrintColor || this.filamentColor;
        const radius = this.lineThickness / 2;

        // Calculate emissive from lighting settings
        const emissiveStrength = 1 - this.lightingSettings.detailLevel;

        // Create material
        const finalMaterial = new BABYLON.StandardMaterial("finalPrintMaterial", this.scene);
        finalMaterial.diffuseColor = colorToUse.clone();
        finalMaterial.emissiveColor = new BABYLON.Color3(
            colorToUse.r * emissiveStrength,
            colorToUse.g * emissiveStrength,
            colorToUse.b * emissiveStrength
        );
        finalMaterial.specularColor = new BABYLON.Color3(0, 0, 0);
        finalMaterial.backFaceCulling = false;

        // Lightweight mode: tessellation 4, no caps (restore)
        // Full mode: tessellation 6, capped ends (after live print)
        const tessellation = lightweight ? 4 : 6;
        const cap = lightweight ? BABYLON.Mesh.NO_CAP : BABYLON.Mesh.CAP_ALL;

        // Create tubes
        const tubeMeshes = [];
        for (let i = 0; i < allSegments.length; i++) {
            const segment = allSegments[i];
            if (segment.length < 2) continue;

            try {
                const tube = BABYLON.MeshBuilder.CreateTube(`final_segment_${i}`, {
                    path: segment,
                    radius: radius,
                    tessellation: tessellation,
                    cap: cap,
                    updatable: false
                }, this.scene);
                tube.material = finalMaterial;
                tubeMeshes.push(tube);
            } catch (e) {
                // Skip invalid segments
            }
        }

        // Merge all tubes into one mesh for performance
        if (tubeMeshes.length > 0) {
            if (tubeMeshes.length === 1) {
                this.lineMesh = tubeMeshes[0];
            } else {
                this.lineMesh = BABYLON.Mesh.MergeMeshes(
                    tubeMeshes,
                    true,   // disposeSource
                    true,   // allow32BitsIndices
                    undefined,
                    false,  // subdivideWithSubMeshes
                    true    // multiMultiMaterial
                );
                if (this.lineMesh) {
                    this.lineMesh.material = finalMaterial;
                }
            }

            if (this.lineMesh) {
                this.lineMesh.renderingGroupId = 1;
                this.lineMesh.isPickable = false;
            }
        }
    }

    /**
     * Get color for layer (rainbow effect)
     */
    getLayerColor(layer) {
        const hue = (layer * 20) % 360;
        const rgb = this.hslToRgb(hue, 70, 60);
        return new BABYLON.Color3(rgb.r, rgb.g, rgb.b);
    }

    /**
     * Create cylinder geometry (SLOW but looks better)
     */
    createCylinderGeometry(from, to, layer) {
        // Force merge if too much geometry
        if (this.printedGeometry.length > this.maxGeometryCount) {
            this.mergeLayers(Math.max(0, layer - 10), layer);
        }

        const distance = BABYLON.Vector3.Distance(from, to);
        const cylinder = BABYLON.MeshBuilder.CreateCylinder("extrusion", {
            height: distance,
            diameter: this.nozzleDiameter * this.lineThickness,
            tessellation: 4
        }, this.scene);

        const midpoint = BABYLON.Vector3.Center(from, to);
        cylinder.position = midpoint;

        const direction = to.subtract(from).normalize();
        const up = new BABYLON.Vector3(0, 1, 0);
        if (Math.abs(direction.y) < 0.99) {
            const axis = BABYLON.Vector3.Cross(up, direction).normalize();
            const angle = Math.acos(BABYLON.Vector3.Dot(up, direction));
            cylinder.rotate(axis, angle, BABYLON.Space.WORLD);
        }

        const material = new BABYLON.StandardMaterial("extrusionMat", this.scene);

        // Apply color based on rainbow mode
        if (this.rainbowMode) {
            const hue = (layer * 20) % 360;
            material.diffuseColor = this.hslToRgb(hue, 70, 60);
        } else {
            material.diffuseColor = this.filamentColor;
        }

        material.specularColor = new BABYLON.Color3(0.2, 0.2, 0.2);
        cylinder.material = material;
        cylinder.isPickable = false; // Don't allow selecting printed geometry

        cylinder.metadata = { layer: layer };
        this.printedGeometry.push(cylinder);
    }

    /**
     * Merge layers into single mesh for performance
     */
    mergeLayers(startLayer, endLayer) {
        const meshesToMerge = this.printedGeometry.filter(mesh => {
            const layer = mesh.metadata?.layer || 0;
            return layer >= startLayer && layer < endLayer;
        });

        if (meshesToMerge.length === 0) return;

        // Create merged mesh
        const merged = BABYLON.Mesh.MergeMeshes(
            meshesToMerge,
            true,
            true,
            undefined,
            false,
            true
        );

        if (merged) {
            merged.name = `merged_layers_${startLayer}_${endLayer}`;
            merged.isPickable = false; // Don't allow selecting printed geometry
            this.mergedMeshes.push(merged);

            // Remove original meshes from tracking
            this.printedGeometry = this.printedGeometry.filter(
                mesh => !meshesToMerge.includes(mesh)
            );
        }
    }

    /**
     * Convert HSL to RGB color
     */
    hslToRgb(h, s, l) {
        h = h / 360;
        s = s / 100;
        l = l / 100;

        let r, g, b;

        if (s === 0) {
            r = g = b = l;
        } else {
            const hue2rgb = (p, q, t) => {
                if (t < 0) t += 1;
                if (t > 1) t -= 1;
                if (t < 1/6) return p + (q - p) * 6 * t;
                if (t < 1/2) return q;
                if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
                return p;
            };

            const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
            const p = 2 * l - q;
            r = hue2rgb(p, q, h + 1/3);
            g = hue2rgb(p, q, h);
            b = hue2rgb(p, q, h - 1/3);
        }

        return new BABYLON.Color3(r, g, b);
    }

    /**
     * Toggle visibility of printer components
     */
    togglePrintHead(visible) {
        if (this.printHead) {
            this.printHead.setEnabled(visible);
        }
    }

    toggleBuildPlate(visible) {
        if (this.buildPlate) {
            this.buildPlate.setEnabled(visible);
        }
    }

    /**
     * Start render loop
     * Per-frame cost is now constant (O(1)) so no throttling needed
     */
    startRenderLoop() {
        this.engine.runRenderLoop(() => this.scene.render());

        // Only bind resize once to avoid listener leaks
        if (!this._resizeHandler) {
            this._resizeHandler = () => this.engine.resize();
            window.addEventListener('resize', this._resizeHandler);
        }
    }

    /**
     * Set playback speed
     */
    setSpeed(speed) {
        this.speed = speed;
        // Reset accumulator when speed changes to prevent lag
        // This ensures speed changes are immediate
        this.frameAccumulator = 0;
    }

    /**
     * Set simplification level for geometry
     */
    setSimplificationLevel(level) {
        this.simplificationLevel = level;
    }

    /**
     * Set layer merge interval
     */
    setLayerMergeInterval(interval) {
        this.layerMergeInterval = interval;
    }

    /**
     * Set filament color from hex string
     */
    setFilamentColor(hex) {
        // Remove # if present
        hex = hex.replace('#', '');

        // Convert hex to RGB (0-1 range)
        const r = parseInt(hex.substring(0, 2), 16) / 255;
        const g = parseInt(hex.substring(2, 4), 16) / 255;
        const b = parseInt(hex.substring(4, 6), 16) / 255;

        this.filamentColor = new BABYLON.Color3(r, g, b);
    }

    /**
     * Get current progress
     */
    getProgress() {
        if (this.commands.length === 0) return 0;
        return (this.currentCommandIndex / this.commands.length) * 100;
    }

    /**
     * Quick print - render final result in batches
     */
    quickPrint(onComplete, skipFinalRender) {
        if (!this.commands || this.commands.length === 0) return;

        // Process all commands without animation
        this.clearPrint();
        this.currentCommandIndex = 0;

        // Disable mesh updates during quick print
        const originalUpdateCounter = this.updateCounter;
        this.isQuickPrinting = true;
        this._skipFinalRender = skipFinalRender || false;
        this.useInterpolation = false; // Disable interpolation for quick print
        this.lastSegmentCount = 0; // Reset so final update will work

        // Process commands in batches to avoid freezing
        const batchSize = 10000; // Process 10000 commands per frame (no geometry overhead during quickPrint)
        const totalCommands = this.commands.length;
        let processedCount = 0;

        const processBatch = () => {
            const endIndex = Math.min(processedCount + batchSize, totalCommands);

            // Process batch
            for (let i = processedCount; i < endIndex; i++) {
                const command = this.commands[i];
                this.executeCommand(command);
                this.currentCommandIndex = i + 1;
            }

            processedCount = endIndex;

            // Update progress periodically (but don't update mesh)
            if (this.onProgress && processedCount % 5000 === 0) {
                const currentCommand = this.commands[processedCount - 1];
                this.onProgress({
                    commandIndex: processedCount,
                    totalCommands: totalCommands,
                    layer: currentCommand?.layer || 0,
                    position: currentCommand?.position || { x: 0, y: 0, z: 0 },
                    extruding: false
                });
            }

            // Check if done
            if (processedCount >= totalCommands) {
                // Re-enable mesh updates
                this.isQuickPrinting = false;

                // Capture final segment
                if (this.currentSegment.length > 1) {
                    this.allPathSegments.push([...this.currentSegment]);
                    this.currentSegment = [];
                }

                // Build all geometry at once (pauses render loop for clean result)
                this._bulkBuildGeometry(() => {
                    // Hide print head since print is complete
                    if (this.printHead) {
                        this.printHead.setEnabled(false);
                    }

                    // Enable click-to-remove interaction
                    this.enablePrintInteraction();

                    // Update progress to 100%
                    if (this.onProgress) {
                        const lastCommand = this.commands[totalCommands - 1];
                        this.onProgress({
                            commandIndex: totalCommands,
                            totalCommands: totalCommands,
                            layer: lastCommand?.layer || 0,
                            position: lastCommand?.position || { x: 0, y: 0, z: 0 },
                            extruding: false
                        });
                    }

                    // Call completion callback
                    if (onComplete) {
                        onComplete();
                    }

                    // Call onComplete callback
                    if (this.onComplete) {
                        this.onComplete();
                    }
                });
            } else {
                // Schedule next batch
                requestAnimationFrame(processBatch);
            }
        };

        // Start processing
        processBatch();
    }

    /**
     * Build all tube geometry from allPathSegments in one synchronous pass.
     * Pauses the render loop so no intermediate frames are drawn — the complete
     * model appears all at once when the render loop resumes.
     */
    _bulkBuildGeometry(onComplete) {
        const allSegments = this.allPathSegments;
        if (allSegments.length === 0) {
            if (onComplete) onComplete();
            return;
        }

        // Pause render loop so geometry doesn't visually build up
        this.engine.stopRenderLoop();

        const radius = this.lineThickness / 2;
        const colorToUse = this.lockedPrintColor || this.filamentColor;
        const emissiveStrength = 1 - this.lightingSettings.detailLevel;

        // Dispose any existing print geometry
        if (this.lineMesh) {
            this.lineMesh.dispose();
            this.lineMesh = null;
        }
        this.frozenMeshes.forEach(m => { if (m) m.dispose(); });
        this.frozenMeshes = [];

        // Create all tubes synchronously
        const tubeMeshes = [];
        for (let i = 0; i < allSegments.length; i++) {
            const segment = allSegments[i];
            if (segment.length < 2) continue;

            let material;
            if (this.rainbowMode) {
                const layerColor = this.getLayerColor(Math.floor(i * 3));
                material = new BABYLON.StandardMaterial(`bulk_rainbow_${i}`, this.scene);
                material.diffuseColor = layerColor;
                material.emissiveColor = new BABYLON.Color3(
                    layerColor.r * emissiveStrength,
                    layerColor.g * emissiveStrength,
                    layerColor.b * emissiveStrength
                );
                material.specularColor = new BABYLON.Color3(0, 0, 0);
                material.backFaceCulling = false;
            } else {
                if (!this.frozenMaterial) {
                    this.frozenMaterial = new BABYLON.StandardMaterial("bulkFrozenMaterial", this.scene);
                    this.frozenMaterial.diffuseColor = colorToUse.clone();
                    this.frozenMaterial.emissiveColor = new BABYLON.Color3(
                        colorToUse.r * emissiveStrength,
                        colorToUse.g * emissiveStrength,
                        colorToUse.b * emissiveStrength
                    );
                    this.frozenMaterial.specularColor = new BABYLON.Color3(0, 0, 0);
                    this.frozenMaterial.backFaceCulling = false;
                }
                material = this.frozenMaterial;
            }

            try {
                const tube = BABYLON.MeshBuilder.CreateTube(`bulk_seg_${i}`, {
                    path: segment,
                    radius: radius,
                    tessellation: 3,
                    cap: BABYLON.Mesh.NO_CAP,
                    updatable: false
                }, this.scene);
                tube.material = material;
                tubeMeshes.push(tube);
            } catch (e) {
                // Skip invalid segments
            }
        }

        // Single merge operation
        if (tubeMeshes.length > 0) {
            if (tubeMeshes.length === 1) {
                tubeMeshes[0].renderingGroupId = 1;
                tubeMeshes[0].isPickable = false;
                tubeMeshes[0].freezeWorldMatrix();
                this.frozenMeshes = [tubeMeshes[0]];
            } else {
                const merged = BABYLON.Mesh.MergeMeshes(
                    tubeMeshes,
                    true,
                    true,
                    undefined,
                    false,
                    true
                );
                if (merged) {
                    merged.renderingGroupId = 1;
                    merged.isPickable = false;
                    merged.freezeWorldMatrix();
                    this.frozenMeshes = [merged];
                }
            }
        }

        // Resume render loop — complete model appears instantly
        this.startRenderLoop();

        if (onComplete) onComplete();
    }

    /**
     * Start heat-up simulation
     */
    startHeatup(onComplete) {
        if (this.isHeating) return;

        this.isHeating = true;
        const startTime = Date.now();

        // Simulate heat-up (takes about 2-3 seconds)
        // Real printers take 1-3 minutes, but we speed it up for UX
        const heatupDuration = 2500; // 2.5 seconds

        this.heatupInterval = setInterval(() => {
            const elapsed = Date.now() - startTime;
            const progress = Math.min(elapsed / heatupDuration, 1.0);

            // Ease-out curve for realistic heating
            const easeProgress = 1 - Math.pow(1 - progress, 3);

            // Update temperatures with some randomness for realism
            const hotendDelta = this.targetHotendTemp - 20;
            const bedDelta = this.targetBedTemp - 20;

            this.currentHotendTemp = Math.floor(20 + (hotendDelta * easeProgress) + (Math.random() * 3 - 1.5));
            this.currentBedTemp = Math.floor(20 + (bedDelta * easeProgress) + (Math.random() * 2 - 1));

            // Clamp to target
            if (this.currentHotendTemp > this.targetHotendTemp) this.currentHotendTemp = this.targetHotendTemp;
            if (this.currentBedTemp > this.targetBedTemp) this.currentBedTemp = this.targetBedTemp;

            // Update display (with null check for removed elements)
            const tempEl = document.getElementById('temp');
            if (tempEl) tempEl.textContent = this.currentHotendTemp;
            // Also update HUD if available
            const hudTempEl = document.getElementById('hud-temp');
            if (hudTempEl) hudTempEl.textContent = `${String(this.currentHotendTemp).padStart(3, ' ')}°C`;
            const hudBedTempEl = document.getElementById('hud-bed-temp');
            if (hudBedTempEl) hudBedTempEl.textContent = `${String(this.currentBedTemp).padStart(3, ' ')}°C`;

            // Check if heating complete
            if (progress >= 1.0) {
                clearInterval(this.heatupInterval);
                this.isHeating = false;
                this.currentHotendTemp = this.targetHotendTemp;
                this.currentBedTemp = this.targetBedTemp;
                if (tempEl) tempEl.textContent = this.currentHotendTemp;
                if (hudTempEl) hudTempEl.textContent = `${String(this.currentHotendTemp).padStart(3, ' ')}°C`;
                if (hudBedTempEl) hudBedTempEl.textContent = `${String(this.currentBedTemp).padStart(3, ' ')}°C`;

                if (onComplete) {
                    onComplete();
                }
            }
        }, 50); // Update every 50ms
    }

    /**
     * Reset temperature to room temperature
     */
    resetTemperature() {
        if (this.heatupInterval) {
            clearInterval(this.heatupInterval);
            this.heatupInterval = null;
        }
        this.isHeating = false;
        this.currentHotendTemp = 20;
        this.currentBedTemp = 20;
        // Update display (with null checks for removed elements)
        const tempEl = document.getElementById('temp');
        if (tempEl) tempEl.textContent = this.currentHotendTemp;
        const hudTempEl = document.getElementById('hud-temp');
        if (hudTempEl) hudTempEl.textContent = `${String(this.currentHotendTemp).padStart(3, ' ')}°C`;
        const hudBedTempEl = document.getElementById('hud-bed-temp');
        if (hudBedTempEl) hudBedTempEl.textContent = `${String(this.currentBedTemp).padStart(3, ' ')}°C`;
    }

    /**
     * Simulate realistic temperature fluctuation during printing
     * Real printers fluctuate ±2-3°C around the target due to PID controller behavior
     */
    fluctuateTemperatures() {
        const now = Date.now();
        // Only update every 2-4 seconds (randomized for natural feel)
        if (now - this.lastTempFluctuation < 2000) return;
        this.lastTempFluctuation = now + Math.random() * 2000; // Add 0-2s randomness

        // Hotend fluctuates ±2°C (more thermal mass = smaller fluctuation)
        const hotendFluctuation = (Math.random() - 0.5) * 4; // -2 to +2
        this.currentHotendTemp = Math.round(this.targetHotendTemp + hotendFluctuation);

        // Bed fluctuates ±1°C (larger thermal mass = even smaller fluctuation)
        const bedFluctuation = (Math.random() - 0.5) * 2; // -1 to +1
        this.currentBedTemp = Math.round(this.targetBedTemp + bedFluctuation);
    }

    /**
     * Export the printed model as STL file
     */
    exportAsSTL() {
        // Get loaded models from global scope
        if (typeof loadedModels === 'undefined' || loadedModels.length === 0) {
            alert('No models on build plate to export! Please load STL files first.');
            return;
        }

        // Collect all preview meshes from loaded models
        // Note: Don't check isEnabled() because meshes are hidden during print simulation
        const meshesToExport = [];
        for (const model of loadedModels) {
            if (model.previewMesh) {
                meshesToExport.push(model.previewMesh);
            }
        }

        if (meshesToExport.length === 0) {
            alert('No models to export! Model data may be missing.');
            return;
        }

        // Clone meshes before merging to preserve originals
        const clonedMeshes = meshesToExport.map((mesh, index) => {
            // Create a deep clone with geometry
            const clone = mesh.clone(`export_clone_${index}`, null, true, false);

            // Copy all transformations from original
            clone.position = mesh.position.clone();
            clone.rotation = mesh.rotation.clone();
            clone.scaling = mesh.scaling.clone();

            // Force world matrix computation
            clone.computeWorldMatrix(true);

            // Bake transformations into vertices so they're in world space
            clone.bakeCurrentTransformIntoVertices();

            return clone;
        });

        // Merge all cloned meshes into a single mesh for export
        const exportMesh = BABYLON.Mesh.MergeMeshes(
            clonedMeshes,
            true, // disposeSource - true to clean up clones
            true, // allow32BitsIndices - support large models
            undefined, // meshSubclass
            false, // subdivideWithSubMeshes
            false  // multiMultiMaterials
        );

        if (!exportMesh) {
            alert('Failed to merge meshes for export!');
            return;
        }

        // Generate STL file content
        const stlString = this.generateSTL(exportMesh);

        // Clean up the temporary merged mesh
        exportMesh.dispose();

        // Create blob and download
        const blob = new Blob([stlString], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'build_plate_models.stl';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);

        console.log(`STL file exported successfully! (${loadedModels.length} model${loadedModels.length > 1 ? 's' : ''} merged)`);
    }

    /**
     * Generate STL file content from a mesh
     */
    generateSTL(mesh) {
        const positions = mesh.getVerticesData(BABYLON.VertexBuffer.PositionKind);
        const indices = mesh.getIndices();

        if (!positions || !indices) {
            throw new Error('Mesh has no geometry data!');
        }

        let stl = 'solid print_model\n';

        // Process each triangle
        for (let i = 0; i < indices.length; i += 3) {
            const i1 = indices[i] * 3;
            const i2 = indices[i + 1] * 3;
            const i3 = indices[i + 2] * 3;

            // Get vertices
            const v1 = new BABYLON.Vector3(positions[i1], positions[i1 + 1], positions[i1 + 2]);
            const v2 = new BABYLON.Vector3(positions[i2], positions[i2 + 1], positions[i2 + 2]);
            const v3 = new BABYLON.Vector3(positions[i3], positions[i3 + 1], positions[i3 + 2]);

            // Calculate normal
            const edge1 = v2.subtract(v1);
            const edge2 = v3.subtract(v1);
            const normal = BABYLON.Vector3.Cross(edge1, edge2).normalize();

            // Write facet
            stl += `  facet normal ${normal.x.toExponential(6)} ${normal.y.toExponential(6)} ${normal.z.toExponential(6)}\n`;
            stl += `    outer loop\n`;
            stl += `      vertex ${v1.x.toExponential(6)} ${v1.y.toExponential(6)} ${v1.z.toExponential(6)}\n`;
            stl += `      vertex ${v2.x.toExponential(6)} ${v2.y.toExponential(6)} ${v2.z.toExponential(6)}\n`;
            stl += `      vertex ${v3.x.toExponential(6)} ${v3.y.toExponential(6)} ${v3.z.toExponential(6)}\n`;
            stl += `    endloop\n`;
            stl += `  endfacet\n`;
        }

        stl += 'endsolid print_model\n';
        return stl;
    }

    /**
     * Generate STL data string without downloading (for export to assets)
     * @returns {string|null} STL file content as string, or null if no models
     */
    generateSTLData() {
        // Get loaded models from global scope
        if (typeof loadedModels === 'undefined' || loadedModels.length === 0) {
            return null;
        }

        // Collect all preview meshes from loaded models
        const meshesToExport = [];
        for (const model of loadedModels) {
            if (model.previewMesh) {
                meshesToExport.push(model.previewMesh);
            }
        }

        if (meshesToExport.length === 0) {
            return null;
        }

        // Clone meshes before merging to preserve originals
        const clonedMeshes = meshesToExport.map((mesh, index) => {
            const clone = mesh.clone(`export_clone_${index}`, null, true, false);
            clone.position = mesh.position.clone();
            clone.rotation = mesh.rotation.clone();
            clone.scaling = mesh.scaling.clone();
            clone.computeWorldMatrix(true);
            clone.bakeCurrentTransformIntoVertices();
            return clone;
        });

        // Merge all cloned meshes into a single mesh for export
        const exportMesh = BABYLON.Mesh.MergeMeshes(
            clonedMeshes,
            true,
            true,
            undefined,
            false,
            false
        );

        if (!exportMesh) {
            return null;
        }

        // Generate STL file content
        const stlString = this.generateSTL(exportMesh);

        // Clean up the temporary merged mesh
        exportMesh.dispose();

        return stlString;
    }

    /**
     * Export the printed model as glTF file
     */
    async exportAsGLTF() {
        // Get loaded models from global scope
        if (typeof loadedModels === 'undefined' || loadedModels.length === 0) {
            alert('No models on build plate to export! Please load STL files first.');
            return;
        }

        // Check if GLTF2Export is available
        if (typeof BABYLON.GLTF2Export === 'undefined') {
            alert('glTF export is not available. Please make sure the Babylon.js serializers library is loaded.');
            return;
        }

        // Collect all preview meshes from loaded models
        // Note: Don't check isEnabled() because meshes are hidden during print simulation
        const meshesToExport = [];
        for (const model of loadedModels) {
            if (model.previewMesh) {
                meshesToExport.push(model.previewMesh);
            }
        }

        if (meshesToExport.length === 0) {
            alert('No models to export! Model data may be missing.');
            return;
        }

        // Create a material with the selected filament color for export
        const exportMaterial = new BABYLON.StandardMaterial("export_material", this.scene);
        exportMaterial.diffuseColor = this.filamentColor.clone();
        exportMaterial.specularColor = new BABYLON.Color3(0.2, 0.2, 0.2);
        exportMaterial.alpha = 1.0; // Fully opaque for export

        // Temporarily replace materials with colored material for export
        const originalMaterials = [];
        for (const mesh of meshesToExport) {
            originalMaterials.push(mesh.material);
            mesh.material = exportMaterial;
        }

        try {
            // Export using Babylon's GLTF exporter
            // This preserves colors, materials, and creates a web-friendly format
            const result = await BABYLON.GLTF2Export.GLBAsync(this.scene, 'build_plate_models', {
                shouldExportNode: (node) => {
                    // Only export the loaded models' preview meshes
                    return meshesToExport.includes(node);
                }
            });

            // Download the file
            result.downloadFiles();

            console.log(`glTF file exported successfully! (${loadedModels.length} model${loadedModels.length > 1 ? 's' : ''} included with ${exportMaterial.diffuseColor.toHexString()} color)`);
        } catch (error) {
            console.error('glTF export error:', error);
            alert('Failed to export as glTF: ' + error.message);
        } finally {
            // Restore original materials
            for (let i = 0; i < meshesToExport.length; i++) {
                meshesToExport[i].material = originalMaterials[i];
            }
            // Clean up export material
            exportMaterial.dispose();
        }
    }

    /**
     * Update scene lighting based on user controls
     * @param {Object} settings - { brightness: 0-1.5, shadowSoftness: 0-1, detailLevel: 0-1 }
     */
    updateLighting(settings) {
        if (!this.mainLight) return;

        this.lightingSettings = { ...this.lightingSettings, ...settings };

        const { brightness, shadowSoftness, detailLevel } = this.lightingSettings;

        // Brightness controls light intensity (0.3 - 1.5)
        this.mainLight.intensity = brightness;

        // Shadow softness controls ground color (higher = softer shadows)
        // 0 = dark ground color (harsh shadows), 1 = same as diffuse (no shadows)
        const groundValue = shadowSoftness;
        this.mainLight.groundColor = new BABYLON.Color3(groundValue, groundValue, groundValue);

        // Detail level controls emissive vs diffuse balance on materials
        // Higher detail = less emissive, more diffuse response = more visible layer lines
        // Lower detail = more emissive = flatter look
        const emissiveStrength = 1 - detailLevel; // Invert: high detail = low emissive

        // Update all frozen meshes and print material
        this.updateMaterialEmissive(emissiveStrength);
    }

    /**
     * Update emissive levels on all printed materials
     * @param {number} emissiveStrength - 0-1, how much emissive color to apply
     */
    updateMaterialEmissive(emissiveStrength) {
        // Update frozen material
        if (this.frozenMaterial) {
            this.frozenMaterial.unfreeze();
            const baseColor = this.frozenMaterial.diffuseColor;
            this.frozenMaterial.emissiveColor = new BABYLON.Color3(
                baseColor.r * emissiveStrength,
                baseColor.g * emissiveStrength,
                baseColor.b * emissiveStrength
            );
            this.frozenMaterial.freeze();
        }

        // Update active material
        if (this.activeMaterial) {
            const baseColor = this.activeMaterial.diffuseColor;
            this.activeMaterial.emissiveColor = new BABYLON.Color3(
                baseColor.r * emissiveStrength,
                baseColor.g * emissiveStrength,
                baseColor.b * emissiveStrength
            );
        }

        // Update frozen meshes
        if (this.frozenMeshes) {
            for (const mesh of this.frozenMeshes) {
                if (mesh.material && mesh.material.diffuseColor) {
                    const baseColor = mesh.material.diffuseColor;
                    mesh.material.emissiveColor = new BABYLON.Color3(
                        baseColor.r * emissiveStrength,
                        baseColor.g * emissiveStrength,
                        baseColor.b * emissiveStrength
                    );
                }
            }
        }

        // Update loaded model preview meshes (if any are using StandardMaterial)
        if (typeof loadedModels !== 'undefined') {
            for (const model of loadedModels) {
                if (model.previewMesh && model.previewMesh.material && model.previewMesh.material.diffuseColor) {
                    const baseColor = model.previewMesh.material.diffuseColor;
                    model.previewMesh.material.emissiveColor = new BABYLON.Color3(
                        baseColor.r * emissiveStrength,
                        baseColor.g * emissiveStrength,
                        baseColor.b * emissiveStrength
                    );
                }
            }
        }
    }

    // ========================================================================
    // Print Interaction — click-to-remove finished prints
    // ========================================================================

    /**
     * Enable click interaction on the finished print.
     * Makes frozen meshes pickable, shows hover highlight, and click popup.
     */
    enablePrintInteraction() {
        if (!this.scene) return;

        // Make frozen meshes pickable
        for (const mesh of this.frozenMeshes) {
            if (mesh) mesh.isPickable = true;
        }

        // Add pointer observable for hover and click
        this.printObserver = this.scene.onPointerObservable.add((pointerInfo) => {
            switch (pointerInfo.type) {
                case BABYLON.PointerEventTypes.POINTERMOVE: {
                    const pickResult = this.scene.pick(
                        this.scene.pointerX,
                        this.scene.pointerY,
                        (mesh) => this._isPrintMesh(mesh)
                    );
                    if (pickResult.hit) {
                        this.canvas.style.cursor = 'pointer';
                        this._applyPrintHighlight();
                    } else {
                        this.canvas.style.cursor = 'default';
                        this._clearPrintHighlight();
                    }
                    break;
                }
                case BABYLON.PointerEventTypes.POINTERDOWN: {
                    const pickResult = this.scene.pick(
                        this.scene.pointerX,
                        this.scene.pointerY,
                        (mesh) => this._isPrintMesh(mesh)
                    );
                    if (pickResult.hit) {
                        const evt = pointerInfo.event;
                        this._showRemovePopup(evt.clientX, evt.clientY);
                    }
                    break;
                }
            }
        });
    }

    /**
     * Remove the finished print from the bed.
     * Disposes all frozen/merged/active geometry, resets printer to home.
     */
    removePrint() {
        this.disablePrintInteraction();

        // Dispose all frozen/merged geometry
        for (const mesh of this.frozenMeshes) {
            if (mesh) {
                if (mesh.material && mesh.material !== this.frozenMaterial) {
                    mesh.material.dispose();
                }
                mesh.dispose();
            }
        }
        this.frozenMeshes = [];

        // Dispose active segment mesh
        if (this.lineMesh) {
            this.lineMesh.dispose();
            this.lineMesh = null;
        }

        // Clear segment data
        this.pathSegments = [];
        this.allPathSegments = [];
        this.currentSegment = [];
        this.totalPointCount = 0;

        // Dispose materials
        if (this.frozenMaterial) {
            this.frozenMaterial.dispose();
            this.frozenMaterial = null;
        }
        if (this.activeMaterial) {
            this.activeMaterial.dispose();
            this.activeMaterial = null;
        }
        if (this.printMaterial) {
            this.printMaterial.dispose();
            this.printMaterial = null;
        }

        // Re-show print head at home position
        if (this.printHead) {
            this.printHead.setEnabled(true);
            this.printHead.position.x = 0;
        }
        if (this.xGantry) {
            this.xGantry.position.y = 8.5;
            this.xGantry.position.z = 0;
        }

        // Fire callback
        if (this.onPrintRemoved) {
            this.onPrintRemoved();
        }
    }

    /**
     * Clean up print interaction observers, cursor, highlights, popup.
     */
    disablePrintInteraction() {
        // Remove observer
        if (this.printObserver && this.scene) {
            this.scene.onPointerObservable.remove(this.printObserver);
            this.printObserver = null;
        }

        // Reset cursor
        if (this.canvas) {
            this.canvas.style.cursor = 'default';
        }

        // Clear highlight
        this._clearPrintHighlight();

        // Remove popup
        if (this.removePopup) {
            this.removePopup.remove();
            this.removePopup = null;
        }
    }

    /**
     * Show a "Remove from Bed" popup near the click point.
     */
    _showRemovePopup(x, y) {
        // Remove existing popup
        if (this.removePopup) {
            this.removePopup.remove();
        }

        const popup = document.createElement('div');
        popup.style.cssText = `
            position: fixed;
            background: #1a1a2e;
            border: 1px solid #bb86fc;
            border-radius: 8px;
            padding: 12px 16px;
            z-index: 1000;
            box-shadow: 0 4px 20px rgba(0,0,0,0.5);
            font-family: inherit;
        `;

        const btn = document.createElement('button');
        btn.textContent = 'Remove from Bed';
        btn.style.cssText = `
            background: linear-gradient(135deg, #e94560, #c62a40);
            color: white;
            border: none;
            padding: 8px 16px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 13px;
            font-weight: 500;
            font-family: inherit;
        `;
        btn.addEventListener('click', () => {
            this.removePrint();
        });
        btn.addEventListener('mouseenter', () => {
            btn.style.background = 'linear-gradient(135deg, #ff5a7a, #e94560)';
        });
        btn.addEventListener('mouseleave', () => {
            btn.style.background = 'linear-gradient(135deg, #e94560, #c62a40)';
        });

        popup.appendChild(btn);
        document.body.appendChild(popup);

        // Position within viewport
        const rect = popup.getBoundingClientRect();
        let left = x;
        let top = y - rect.height - 10;
        if (left + rect.width > window.innerWidth) left = window.innerWidth - rect.width - 10;
        if (top < 0) top = y + 10;
        popup.style.left = left + 'px';
        popup.style.top = top + 'px';

        this.removePopup = popup;

        // Close on outside click
        const closeHandler = (e) => {
            if (!popup.contains(e.target)) {
                popup.remove();
                this.removePopup = null;
                document.removeEventListener('pointerdown', closeHandler);
            }
        };
        // Delay to avoid immediate close from the same click
        setTimeout(() => {
            document.addEventListener('pointerdown', closeHandler);
        }, 100);
    }

    /**
     * Check if a mesh belongs to the printed model.
     */
    _isPrintMesh(mesh) {
        return this.frozenMeshes.includes(mesh) || mesh === this.lineMesh;
    }

    /**
     * Apply hover highlight (emissive brightness boost) to print meshes.
     */
    _applyPrintHighlight() {
        for (const mesh of this.frozenMeshes) {
            if (mesh && mesh.material) {
                if (!mesh._originalEmissive) {
                    mesh._originalEmissive = mesh.material.emissiveColor.clone();
                }
                const base = mesh.material.diffuseColor;
                mesh.material.emissiveColor = new BABYLON.Color3(
                    Math.min(base.r * 0.7, 1),
                    Math.min(base.g * 0.7, 1),
                    Math.min(base.b * 0.7, 1)
                );
            }
        }
    }

    /**
     * Clear hover highlight from print meshes.
     */
    _clearPrintHighlight() {
        for (const mesh of this.frozenMeshes) {
            if (mesh && mesh.material && mesh._originalEmissive) {
                mesh.material.emissiveColor = mesh._originalEmissive.clone();
                delete mesh._originalEmissive;
            }
        }
    }
}
