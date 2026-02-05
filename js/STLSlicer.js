/**
 * STL File Parser and Slicer
 * Converts STL 3D models into G-code
 */
class STLSlicer {
    constructor() {
        this.mesh = null;
        this.layerHeight = 0.2;
        this.infillPattern = 'grid';
        this.infillDensity = 20;
        this.nozzleTemp = 200;
        this.bedTemp = 60;
        this.wallThickness = 0.8; // 2 perimeters
        this.topBottomLayers = 3; // Number of solid layers at top and bottom
        this.nozzleDiameter = 0.4; // Nozzle size in mm (default 0.4mm - standard size)
    }

    /**
     * Parse STL file (binary or ASCII format)
     */
    async parseSTL(file) {
        const buffer = await file.arrayBuffer();
        const view = new DataView(buffer);

        // Check if binary or ASCII
        const header = new TextDecoder().decode(new Uint8Array(buffer, 0, 80));
        if (header.toLowerCase().includes('solid')) {
            return this.parseASCIISTL(buffer);
        } else {
            return this.parseBinarySTL(buffer, view);
        }
    }

    /**
     * Parse binary STL format
     */
    parseBinarySTL(buffer, view) {
        const triangles = [];

        // Skip 80-byte header
        const numTriangles = view.getUint32(80, true);

        for (let i = 0; i < numTriangles; i++) {
            const offset = 84 + i * 50;

            // Normal vector (skip for now)
            // const normal = {
            //     x: view.getFloat32(offset, true),
            //     y: view.getFloat32(offset + 4, true),
            //     z: view.getFloat32(offset + 8, true)
            // };

            // Three vertices
            const v1 = {
                x: view.getFloat32(offset + 12, true),
                y: view.getFloat32(offset + 16, true),
                z: view.getFloat32(offset + 20, true)
            };

            const v2 = {
                x: view.getFloat32(offset + 24, true),
                y: view.getFloat32(offset + 28, true),
                z: view.getFloat32(offset + 32, true)
            };

            const v3 = {
                x: view.getFloat32(offset + 36, true),
                y: view.getFloat32(offset + 40, true),
                z: view.getFloat32(offset + 44, true)
            };

            triangles.push({ v1, v2, v3 });
        }

        console.log(`Parsed ${triangles.length} triangles from STL`);
        this.mesh = triangles;
        return triangles;
    }

    /**
     * Parse ASCII STL format
     */
    parseASCIISTL(buffer) {
        const text = new TextDecoder().decode(buffer);
        const lines = text.split('\n');
        const triangles = [];
        let currentTriangle = null;
        let vertexCount = 0;

        for (const line of lines) {
            const trimmed = line.trim();

            if (trimmed.startsWith('facet')) {
                currentTriangle = { v1: null, v2: null, v3: null };
                vertexCount = 0;
            } else if (trimmed.startsWith('vertex')) {
                const parts = trimmed.split(/\s+/);
                const vertex = {
                    x: parseFloat(parts[1]),
                    y: parseFloat(parts[2]),
                    z: parseFloat(parts[3])
                };

                if (vertexCount === 0) currentTriangle.v1 = vertex;
                else if (vertexCount === 1) currentTriangle.v2 = vertex;
                else if (vertexCount === 2) currentTriangle.v3 = vertex;
                vertexCount++;
            } else if (trimmed.startsWith('endfacet')) {
                if (currentTriangle && currentTriangle.v1 && currentTriangle.v2 && currentTriangle.v3) {
                    triangles.push(currentTriangle);
                }
            }
        }

        console.log(`Parsed ${triangles.length} triangles from ASCII STL`);
        this.mesh = triangles;
        return triangles;
    }

    /**
     * Get bounding box of mesh
     */
    getBoundingBox() {
        if (!this.mesh || this.mesh.length === 0) return null;

        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

        for (const tri of this.mesh) {
            for (const v of [tri.v1, tri.v2, tri.v3]) {
                if (v.x < minX) minX = v.x;
                if (v.y < minY) minY = v.y;
                if (v.z < minZ) minZ = v.z;
                if (v.x > maxX) maxX = v.x;
                if (v.y > maxY) maxY = v.y;
                if (v.z > maxZ) maxZ = v.z;
            }
        }

        return {
            min: { x: minX, y: minY, z: minZ },
            max: { x: maxX, y: maxY, z: maxZ },
            size: { x: maxX - minX, y: maxY - minY, z: maxZ - minZ }
        };
    }

    /**
     * Slice mesh into layers
     */
    sliceMesh() {
        if (!this.mesh) return null;

        const bbox = this.getBoundingBox();
        const numLayers = Math.ceil(bbox.size.z / this.layerHeight);
        const layers = [];

        console.log(`Slicing into ${numLayers} layers...`);

        for (let layerNum = 0; layerNum < numLayers; layerNum++) {
            const z = bbox.min.z + (layerNum + 1) * this.layerHeight;
            const segments = this.sliceAtZ(z);

            if (segments.length > 0) {
                layers.push({
                    layerNum: layerNum,
                    z: z,
                    segments: segments
                });
            }
        }

        console.log(`Created ${layers.length} layers`);
        return layers;
    }

    /**
     * Slice mesh at specific Z height
     */
    sliceAtZ(z) {
        const segments = [];

        for (const tri of this.mesh) {
            const v1 = tri.v1;
            const v2 = tri.v2;
            const v3 = tri.v3;

            // Check if triangle intersects plane
            const intersections = [];

            // Check each edge
            const edges = [
                [v1, v2],
                [v2, v3],
                [v3, v1]
            ];

            for (const [va, vb] of edges) {
                // Check if edge crosses the z plane
                if ((va.z <= z && vb.z >= z) || (va.z >= z && vb.z <= z)) {
                    if (Math.abs(va.z - vb.z) > 0.0001) { // Avoid division by zero
                        const t = (z - va.z) / (vb.z - va.z);
                        const intersection = {
                            x: va.x + t * (vb.x - va.x),
                            y: va.y + t * (vb.y - va.y)
                        };
                        intersections.push(intersection);
                    }
                }
            }

            // If we have exactly 2 intersections, we have a line segment
            if (intersections.length === 2) {
                segments.push({
                    start: intersections[0],
                    end: intersections[1]
                });
            }
        }

        return segments;
    }

    /**
     * Detect horizontal surfaces from mesh triangles
     * Returns arrays of Z heights where top surfaces and bottom surfaces exist
     */
    detectHorizontalSurfaces() {
        if (!this.mesh || this.mesh.length === 0) return { topSurfaces: [], bottomSurfaces: [] };

        const topSurfaces = [];    // Z heights with upward-facing surfaces
        const bottomSurfaces = []; // Z heights with downward-facing surfaces
        // Use layer height as tolerance - surfaces within one layer are the same surface
        const tolerance = this.layerHeight;

        console.log(`\n--- Detecting horizontal surfaces (tolerance: ${tolerance}mm) ---`);

        let topTriangleCount = 0;
        let bottomTriangleCount = 0;

        for (const tri of this.mesh) {
            // Calculate triangle normal
            const v1 = tri.v1;
            const v2 = tri.v2;
            const v3 = tri.v3;

            // Edge vectors
            const edge1 = { x: v2.x - v1.x, y: v2.y - v1.y, z: v2.z - v1.z };
            const edge2 = { x: v3.x - v1.x, y: v3.y - v1.y, z: v3.z - v1.z };

            // Cross product for normal
            const normal = {
                x: edge1.y * edge2.z - edge1.z * edge2.y,
                y: edge1.z * edge2.x - edge1.x * edge2.z,
                z: edge1.x * edge2.y - edge1.y * edge2.x
            };

            // Normalize
            const length = Math.sqrt(normal.x * normal.x + normal.y * normal.y + normal.z * normal.z);
            if (length === 0) continue;
            normal.x /= length;
            normal.y /= length;
            normal.z /= length;

            // Check if horizontal (normal pointing mostly up or down)
            // Use threshold of 0.5 (about 60 degrees from horizontal) to catch more surfaces
            if (Math.abs(normal.z) > 0.5) {
                // Get average Z of triangle (the surface height)
                const avgZ = (v1.z + v2.z + v3.z) / 3;

                if (normal.z > 0) {
                    topTriangleCount++;
                    // Upward-facing = top surface
                    // Check if we already have a similar Z height
                    let found = false;
                    for (const existing of topSurfaces) {
                        if (Math.abs(existing - avgZ) < tolerance) {
                            found = true;
                            break;
                        }
                    }
                    if (!found) {
                        topSurfaces.push(avgZ);
                        console.log(`  Found TOP surface at Z=${avgZ.toFixed(2)} (normal.z=${normal.z.toFixed(2)})`);
                    }
                } else {
                    bottomTriangleCount++;
                    // Downward-facing = bottom surface
                    let found = false;
                    for (const existing of bottomSurfaces) {
                        if (Math.abs(existing - avgZ) < tolerance) {
                            found = true;
                            break;
                        }
                    }
                    if (!found) {
                        bottomSurfaces.push(avgZ);
                        console.log(`  Found BOTTOM surface at Z=${avgZ.toFixed(2)} (normal.z=${normal.z.toFixed(2)})`);
                    }
                }
            }
        }

        // Sort by Z height
        topSurfaces.sort((a, b) => a - b);
        bottomSurfaces.sort((a, b) => a - b);

        console.log(`Detected ${topSurfaces.length} unique top surface heights (from ${topTriangleCount} triangles)`);
        console.log(`Detected ${bottomSurfaces.length} unique bottom surface heights (from ${bottomTriangleCount} triangles)`);

        return { topSurfaces, bottomSurfaces };
    }

    /**
     * Analyze layer sequences to determine top/bottom solid layers
     * Handles multiple models with different heights correctly
     * Now also detects internal horizontal surfaces from mesh normals
     * Returns array of {isBottom: boolean, isTop: boolean} for each layer
     */
    analyzeLayerSequences(layers) {
        const sequences = new Array(layers.length).fill(null).map(() => ({
            isBottom: false,
            isTop: false
        }));

        if (layers.length === 0) return sequences;

        console.log(`\n=== Analyzing ${layers.length} layers for top/bottom detection ===`);
        console.log(`Top/Bottom layers setting: ${this.topBottomLayers}`);

        // NEW: Detect horizontal surfaces from mesh geometry
        const { topSurfaces, bottomSurfaces } = this.detectHorizontalSurfaces();
        console.log(`Found top surfaces at Z: ${topSurfaces.map(z => z.toFixed(2)).join(', ')}`);
        console.log(`Found bottom surfaces at Z: ${bottomSurfaces.map(z => z.toFixed(2)).join(', ')}`);

        // Mark bottom layers (first N layers from the start)
        for (let i = 0; i < Math.min(this.topBottomLayers, layers.length); i++) {
            sequences[i].isBottom = true;
        }
        console.log(`Marked layers 0-${Math.min(this.topBottomLayers, layers.length) - 1} as BOTTOM layers`);

        // Find top layers by looking for where geometry stops or changes significantly
        // A layer is a "top" layer if:
        // 1. It's one of the last N layers overall (global top)
        // 2. OR the next layer(s) have significantly less geometry (local top)

        for (let i = 0; i < layers.length; i++) {
            // Global top layers (last N layers)
            if (i >= layers.length - this.topBottomLayers) {
                sequences[i].isTop = true;
                if (i === layers.length - this.topBottomLayers) {
                    console.log(`Marked layers ${i} to ${layers.length - 1} as GLOBAL TOP layers`);
                }
                continue;
            }

            // Local top detection: Check if geometry significantly decreases in next layers
            // This handles shorter models on the same build plate
            const currentSegments = layers[i].segments.length;

            // NEW: Calculate total path length as a better metric than segment count
            // This catches when small models disappear even if large models remain
            let currentPathLength = 0;
            for (const seg of layers[i].segments) {
                const dx = seg.end.x - seg.start.x;
                const dy = seg.end.y - seg.start.y;
                currentPathLength += Math.sqrt(dx * dx + dy * dy);
            }

            // Look ahead further to catch geometry decreases (up to topBottomLayers + 1)
            let geometryDecreases = false;
            const lookAheadLayers = Math.min(this.topBottomLayers + 1, layers.length - i - 1);

            // Debug: Log segment counts and path length for analysis
            if (i % 5 === 0) { // Log every 5th layer to avoid spam
                console.log(`  Layer ${i}: ${currentSegments} segments, ${currentPathLength.toFixed(1)} path length`);
            }

            for (let j = 1; j <= lookAheadLayers; j++) {
                const nextIndex = i + j;
                if (nextIndex < layers.length) {
                    const nextSegments = layers[nextIndex].segments.length;

                    // Calculate next layer's path length
                    let nextPathLength = 0;
                    for (const seg of layers[nextIndex].segments) {
                        const dx = seg.end.x - seg.start.x;
                        const dy = seg.end.y - seg.start.y;
                        nextPathLength += Math.sqrt(dx * dx + dy * dy);
                    }

                    // Calculate percentage decrease in BOTH metrics
                    const segmentDecrease = ((currentSegments - nextSegments) / currentSegments) * 100;
                    const pathDecrease = ((currentPathLength - nextPathLength) / currentPathLength) * 100;

                    // Use path length decrease as primary metric (more accurate for multi-model scenarios)
                    // Lowered to 10% to catch smaller models ending
                    if (pathDecrease > 10 && currentPathLength > 0) {
                        geometryDecreases = true;
                        console.log(`  Layer ${i}: Found ${pathDecrease.toFixed(0)}% path decrease (segments: ${segmentDecrease.toFixed(0)}%) at layer ${nextIndex}`);
                        break;
                    }

                    // ALSO detect when geometry completely disappears (model ends)
                    if (nextSegments === 0 && currentSegments > 0) {
                        geometryDecreases = true;
                        console.log(`  Layer ${i}: Found complete geometry end (${currentSegments} → 0 at layer ${nextIndex})`);
                        break;
                    }
                }
            }

            if (geometryDecreases) {
                // Mark this layer and the previous N-1 layers as top layers
                const startLayer = Math.max(0, i - this.topBottomLayers + 1);
                for (let k = startLayer; k <= i; k++) {
                    sequences[k].isTop = true;
                }
                console.log(`  ✓ Layer ${i}: Detected LOCAL TOP - Marking layers ${startLayer} to ${i} as top (${this.topBottomLayers} layers)`);
            }
        }

        // NEW: Mark layers near detected horizontal surfaces from mesh normals
        // This catches internal horizontal surfaces like the top of a cat's head between ears
        console.log(`\n--- Marking layers near horizontal surfaces ---`);

        const surfaceTolerance = this.topBottomLayers * this.layerHeight + this.layerHeight; // Extra tolerance

        for (const topZ of topSurfaces) {
            // Find layers at or just below this top surface
            // Check within topBottomLayers distance, plus a small buffer for rounding
            for (let i = 0; i < layers.length; i++) {
                const layerZ = layers[i].z;
                const distance = Math.abs(topZ - layerZ);
                // Mark if layer is close to the surface (within N layers below, or slightly above)
                if (distance < surfaceTolerance && layerZ <= topZ + this.layerHeight) {
                    if (!sequences[i].isTop) {
                        sequences[i].isTop = true;
                        console.log(`  ✓ Layer ${i} (Z=${layerZ.toFixed(2)}): Marked as TOP (surface at Z=${topZ.toFixed(2)}, dist=${distance.toFixed(2)})`);
                    }
                }
            }
        }

        for (const bottomZ of bottomSurfaces) {
            // Find layers at or just above this bottom surface
            for (let i = 0; i < layers.length; i++) {
                const layerZ = layers[i].z;
                const distance = Math.abs(layerZ - bottomZ);
                // Mark if layer is close to the surface (within N layers above, or slightly below)
                if (distance < surfaceTolerance && layerZ >= bottomZ - this.layerHeight) {
                    if (!sequences[i].isBottom) {
                        sequences[i].isBottom = true;
                        console.log(`  ✓ Layer ${i} (Z=${layerZ.toFixed(2)}): Marked as BOTTOM (surface at Z=${bottomZ.toFixed(2)}, dist=${distance.toFixed(2)})`);
                    }
                }
            }
        }

        // Summary
        const topLayers = sequences.filter(s => s.isTop).length;
        const bottomLayers = sequences.filter(s => s.isBottom).length;
        console.log(`\n=== Analysis Complete: ${bottomLayers} bottom layers, ${topLayers} top layers ===\n`);

        return sequences;
    }

    /**
     * Generate G-code from sliced layers with custom sequences (for multi-model support)
     */
    generateGCodeWithSequences(layers, infillPattern, infillDensity, sequences) {
        const generator = new GCodeGenerator();
        generator.layerHeight = this.layerHeight;
        const gcode = [];

        // Header
        gcode.push('; Generated by 3D Printer Simulator - STL Slicer');
        gcode.push(`; Layer Height: ${this.layerHeight}mm`);
        gcode.push(`; Infill: ${infillPattern} at ${infillDensity}%`);
        gcode.push(`; Top/Bottom Solid Layers: ${this.topBottomLayers}`);
        gcode.push('; Multi-model per-model top/bottom detection enabled');
        gcode.push('');
        gcode.push('G28 ; Home all axes');
        gcode.push(`M104 S${this.nozzleTemp} ; Set hotend temperature`);
        gcode.push(`M140 S${this.bedTemp} ; Set bed temperature`);
        gcode.push(`G1 Z${this.layerHeight} F5000`);
        gcode.push('');

        let extrusionCounter = 0;

        // Process each layer using provided sequences
        for (let i = 0; i < layers.length; i++) {
            const layer = layers[i];
            gcode.push(`; Layer ${layer.layerNum + 1} (Z=${layer.z.toFixed(3)})`);
            gcode.push(`G1 Z${layer.z.toFixed(3)} F5000`);

            // Generate perimeters from segments
            const paths = this.segmentsToPerimeter(layer.segments);

            if (paths.length > 0) {
                // Use provided sequences for this layer
                const isBottomLayer = sequences[i].isBottom;
                const isTopLayer = sequences[i].isTop;
                const isSolidLayer = isBottomLayer || isTopLayer;

                // Draw all perimeter paths
                for (let pathIdx = 0; pathIdx < paths.length; pathIdx++) {
                    const path = paths[pathIdx];

                    if (pathIdx > 0) {
                        gcode.push(`G0 X${path[0].x.toFixed(2)} Y${path[0].y.toFixed(2)} ; Travel to next shape`);
                    }

                    for (let i = 0; i < path.length; i++) {
                        const point = path[i];
                        if (i === 0 && pathIdx === 0) {
                            gcode.push(`G1 X${point.x.toFixed(2)} Y${point.y.toFixed(2)} E${extrusionCounter++}`);
                        } else if (i === 0) {
                            gcode.push(`G1 X${point.x.toFixed(2)} Y${point.y.toFixed(2)} E${extrusionCounter++}`);
                        } else {
                            gcode.push(`G1 X${point.x.toFixed(2)} Y${point.y.toFixed(2)} E${extrusionCounter += 3} F1500`);
                        }
                    }
                }

                // Generate infill
                const allPoints = paths.flat();
                const bbox = this.getLayerBoundingBox(allPoints);

                if (isSolidLayer) {
                    // Solid infill
                    gcode.push(`; Solid layer ${isBottomLayer ? '(bottom)' : '(top)'}`);
                    const solidInfill1 = this.generateLayerInfill(bbox, 'lines', 100, paths, 0);
                    for (const line of solidInfill1) {
                        gcode.push(line.replace(/E\d+/g, match => `E${extrusionCounter += 3}`));
                    }
                    const solidInfill2 = this.generateLayerInfill(bbox, 'lines', 100, paths, 90);
                    for (const line of solidInfill2) {
                        gcode.push(line.replace(/E\d+/g, match => `E${extrusionCounter += 3}`));
                    }
                } else {
                    // Sparse infill
                    if (infillDensity > 0) {
                        gcode.push(`; Sparse infill (${infillDensity}%)`);
                        const infillLines = this.generateLayerInfill(bbox, infillPattern, infillDensity, paths, 0);
                        for (const line of infillLines) {
                            gcode.push(line.replace(/E\d+/g, match => `E${extrusionCounter += 3}`));
                        }
                    }
                }
            }
        }

        // Footer
        gcode.push('');
        gcode.push('; Print complete');
        gcode.push('G1 Z' + (layers[layers.length - 1].z + 10) + ' F5000');
        gcode.push('M104 S0 ; Turn off hotend');
        gcode.push('M140 S0 ; Turn off bed');
        gcode.push('G28 X0 Y0 ; Home X and Y');
        gcode.push('M84 ; Disable motors');

        return gcode.join('\n');
    }

    /**
     * Generate G-code from sliced layers (original method - kept for compatibility)
     */
    generateGCode(layers, infillPattern, infillDensity) {
        const generator = new GCodeGenerator();
        generator.layerHeight = this.layerHeight;
        const gcode = [];

        // Header
        gcode.push('; Generated by 3D Printer Simulator - STL Slicer');
        gcode.push(`; Layer Height: ${this.layerHeight}mm`);
        gcode.push(`; Infill: ${infillPattern} at ${infillDensity}%`);
        gcode.push(`; Top/Bottom Solid Layers: ${this.topBottomLayers}`);
        gcode.push('');
        gcode.push('G28 ; Home all axes');
        gcode.push(`M104 S${this.nozzleTemp} ; Set hotend temperature`);
        gcode.push(`M140 S${this.bedTemp} ; Set bed temperature`);
        gcode.push(`G1 Z${this.layerHeight} F5000`);
        gcode.push('');

        let extrusionCounter = 0;

        // OPTIMIZATION: Pre-analyze layers to find continuous sequences
        // This handles multiple models with different heights correctly
        const layerSequences = this.analyzeLayerSequences(layers);

        // Process each layer
        for (let i = 0; i < layers.length; i++) {
            const layer = layers[i];
            gcode.push(`; Layer ${layer.layerNum + 1} (Z=${layer.z.toFixed(3)})`);
            gcode.push(`G1 Z${layer.z.toFixed(3)} F5000`);

            // Generate perimeters from segments (returns array of paths)
            const paths = this.segmentsToPerimeter(layer.segments);

            if (paths.length > 0) {
                // Determine if this layer should have solid infill based on LOCAL layer sequences
                // This fixes the bug where shorter models don't get top solid layers
                const isBottomLayer = layerSequences[i].isBottom;
                const isTopLayer = layerSequences[i].isTop;
                const isSolidLayer = isBottomLayer || isTopLayer;

                // Draw all perimeter paths (separate shapes like letters A, B, C)
                for (let pathIdx = 0; pathIdx < paths.length; pathIdx++) {
                    const path = paths[pathIdx];

                    if (pathIdx > 0) {
                        // Travel move to start of next path (non-extruding)
                        gcode.push(`G0 X${path[0].x.toFixed(2)} Y${path[0].y.toFixed(2)} ; Travel to next shape`);
                    }

                    // Draw this closed loop
                    for (let i = 0; i < path.length; i++) {
                        const point = path[i];
                        if (i === 0 && pathIdx === 0) {
                            // First point of first path
                            gcode.push(`G1 X${point.x.toFixed(2)} Y${point.y.toFixed(2)} E${extrusionCounter++}`);
                        } else if (i === 0) {
                            // First point of subsequent paths (already traveled to)
                            gcode.push(`G1 X${point.x.toFixed(2)} Y${point.y.toFixed(2)} E${extrusionCounter++}`);
                        } else {
                            // All other points
                            gcode.push(`G1 X${point.x.toFixed(2)} Y${point.y.toFixed(2)} E${extrusionCounter += 3} F1500`);
                        }
                    }
                }

                // Generate infill
                // Flatten all paths into single array for bbox calculation
                const allPoints = paths.flat();
                const bbox = this.getLayerBoundingBox(allPoints);

                if (isSolidLayer) {
                    // Solid infill for top/bottom layers (100% density)
                    // Use alternating angles (0° and 90°) to catch all geometry including curves
                    gcode.push(`; Solid layer ${isBottomLayer ? '(bottom)' : '(top)'}`);

                    // First direction: horizontal lines (0°)
                    const solidInfill1 = this.generateLayerInfill(bbox, 'lines', 100, paths, 0);
                    for (const line of solidInfill1) {
                        gcode.push(line.replace(/E\d+/g, match => {
                            return `E${extrusionCounter += 3}`;
                        }));
                    }

                    // Second direction: vertical lines (90°) to fill gaps in curves
                    const solidInfill2 = this.generateLayerInfill(bbox, 'lines', 100, paths, 90);
                    for (const line of solidInfill2) {
                        gcode.push(line.replace(/E\d+/g, match => {
                            return `E${extrusionCounter += 3}`;
                        }));
                    }
                } else {
                    // Sparse infill for middle layers
                    if (infillDensity > 0) {
                        gcode.push(`; Sparse infill (${infillDensity}%)`);

                        if (infillPattern === 'grid') {
                            // Grid pattern: lines in both directions (0° and 90°)
                            const infill1 = this.generateLayerInfill(bbox, 'lines', infillDensity, paths, 0);
                            for (const line of infill1) {
                                gcode.push(line.replace(/E\d+/g, match => {
                                    return `E${extrusionCounter += 3}`;
                                }));
                            }

                            const infill2 = this.generateLayerInfill(bbox, 'lines', infillDensity, paths, 90);
                            for (const line of infill2) {
                                gcode.push(line.replace(/E\d+/g, match => {
                                    return `E${extrusionCounter += 3}`;
                                }));
                            }
                        } else {
                            // Other patterns: single direction
                            const infill = this.generateLayerInfill(bbox, infillPattern, infillDensity, paths, 0);
                            for (const line of infill) {
                                gcode.push(line.replace(/E\d+/g, match => {
                                    return `E${extrusionCounter += 3}`;
                                }));
                            }
                        }
                    }
                }
            }

            gcode.push('');
        }

        // Footer
        gcode.push('; Finish');
        gcode.push('G1 Z' + (layers[layers.length - 1].z + 10) + ' F5000');
        gcode.push('M104 S0 ; Turn off hotend');
        gcode.push('M140 S0 ; Turn off bed');
        gcode.push('G28 X Y ; Home X and Y');
        gcode.push('M84 ; Disable steppers');

        return gcode.join('\n');
    }

    /**
     * Convert segments to perimeter paths (with proper path ordering)
     * Returns array of closed loops, each loop is an array of points
     */
    segmentsToPerimeter(segments) {
        if (segments.length === 0) return [];

        // Build connected paths from segments
        const paths = [];
        const unusedSegments = [...segments];
        const tolerance = 0.01; // Distance tolerance for connecting points

        while (unusedSegments.length > 0) {
            const currentPath = [];
            const firstSeg = unusedSegments.shift();

            currentPath.push({ x: firstSeg.start.x, y: firstSeg.start.y });
            currentPath.push({ x: firstSeg.end.x, y: firstSeg.end.y });

            let lastPoint = firstSeg.end;
            let foundConnection = true;

            // Keep connecting segments until we close the loop or can't find more
            while (foundConnection && unusedSegments.length > 0) {
                foundConnection = false;

                for (let i = 0; i < unusedSegments.length; i++) {
                    const seg = unusedSegments[i];
                    const distToStart = Math.hypot(lastPoint.x - seg.start.x, lastPoint.y - seg.start.y);
                    const distToEnd = Math.hypot(lastPoint.x - seg.end.x, lastPoint.y - seg.end.y);

                    if (distToStart < tolerance) {
                        // Connect to start of this segment
                        currentPath.push({ x: seg.end.x, y: seg.end.y });
                        lastPoint = seg.end;
                        unusedSegments.splice(i, 1);
                        foundConnection = true;
                        break;
                    } else if (distToEnd < tolerance) {
                        // Connect to end of this segment (reversed)
                        currentPath.push({ x: seg.start.x, y: seg.start.y });
                        lastPoint = seg.start;
                        unusedSegments.splice(i, 1);
                        foundConnection = true;
                        break;
                    }
                }
            }

            // Only add paths with at least 3 points
            if (currentPath.length >= 3) {
                paths.push(currentPath);
            }
        }

        return paths;
    }

    /**
     * Get bounding box of layer
     */
    getLayerBoundingBox(perimeter) {
        if (perimeter.length === 0) return null;

        let minX = Infinity, minY = Infinity;
        let maxX = -Infinity, maxY = -Infinity;

        for (const point of perimeter) {
            if (point.x < minX) minX = point.x;
            if (point.y < minY) minY = point.y;
            if (point.x > maxX) maxX = point.x;
            if (point.y > maxY) maxY = point.y;
        }

        return { minX, minY, maxX, maxY };
    }

    /**
     * Check if a point is inside a polygon using ray casting algorithm
     */
    isPointInPolygon(point, polygon) {
        let inside = false;
        for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
            const xi = polygon[i].x, yi = polygon[i].y;
            const xj = polygon[j].x, yj = polygon[j].y;

            const intersect = ((yi > point.y) !== (yj > point.y))
                && (point.x < (xj - xi) * (point.y - yi) / (yj - yi) + xi);
            if (intersect) inside = !inside;
        }
        return inside;
    }

    /**
     * Check if a point is inside any of the perimeter paths
     */
    isPointInsidePerimeters(point, paths) {
        for (const path of paths) {
            if (this.isPointInPolygon(point, path)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Check if a point is inside solid geometry (accounting for holes)
     * A point is in solid geometry if it's inside an odd number of polygons
     * (inside outer perimeter = 1, inside outer + inside hole = 2, etc.)
     * This correctly handles holes using the even-odd rule
     */
    isPointInSolidGeometry(point, paths) {
        let count = 0;
        for (const path of paths) {
            if (this.isPointInPolygon(point, path)) {
                count++;
            }
        }
        // Odd count = inside solid, Even count = inside hole
        return count % 2 === 1;
    }

    /**
     * Find horizontal line-polygon intersections for infill clipping
     */
    findLinePolygonIntersections(y, polygon) {
        const intersections = [];

        for (let i = 0; i < polygon.length; i++) {
            const p1 = polygon[i];
            const p2 = polygon[(i + 1) % polygon.length];

            // Check if the edge crosses the horizontal line at y
            // Use < and >= to avoid counting vertices twice (classic scanline problem)
            // This ensures each vertex is only counted once
            if ((p1.y < y && p2.y >= y) || (p1.y >= y && p2.y < y)) {
                if (Math.abs(p2.y - p1.y) > 0.0001) { // Avoid division by zero
                    const t = (y - p1.y) / (p2.y - p1.y);
                    const x = p1.x + t * (p2.x - p1.x);
                    intersections.push(x);
                }
            }
        }

        return intersections;
    }

    /**
     * Find vertical line-polygon intersections for infill clipping
     */
    findVerticalLinePolygonIntersections(x, polygon) {
        const intersections = [];

        for (let i = 0; i < polygon.length; i++) {
            const p1 = polygon[i];
            const p2 = polygon[(i + 1) % polygon.length];

            // Check if the edge crosses the vertical line at x
            // Use < and >= to avoid counting vertices twice (classic scanline problem)
            // This ensures each vertex is only counted once
            if ((p1.x < x && p2.x >= x) || (p1.x >= x && p2.x < x)) {
                if (Math.abs(p2.x - p1.x) > 0.0001) { // Avoid division by zero
                    const t = (x - p1.x) / (p2.x - p1.x);
                    const y = p1.y + t * (p2.y - p1.y);
                    intersections.push(y);
                }
            }
        }

        return intersections;
    }

    /**
     * Generate infill for a layer (clipped to perimeter paths)
     * @param {Object} bbox - Bounding box
     * @param {String} pattern - Infill pattern
     * @param {Number} density - Infill density percentage
     * @param {Array} paths - Perimeter paths
     * @param {Number} angle - Infill angle in degrees (0 = horizontal, 90 = vertical)
     */
    generateLayerInfill(bbox, pattern, density, paths = null, angle = 0) {
        if (!bbox || density === 0) return [];

        const gcode = [];

        // For 100% density (solid layers), use tight spacing with overlap
        // For sparse infill, use density-based spacing with gaps
        // NOTE: Nozzle sizes typically 0.2-1.0mm (default 0.4mm)
        let spacing;
        if (density >= 100) {
            // Solid layers: lines overlap significantly for complete coverage
            // Calculate based on actual nozzle diameter (87.5% for good overlap)
            // This ensures no gaps regardless of nozzle size
            spacing = this.nozzleDiameter * 0.875;
        } else {
            // Sparse infill: significant gaps between lines
            const minSpacing = 2.0; // Minimum spacing for sparse infill (still has gaps)
            const maxSpacing = 20;
            spacing = minSpacing + ((100 - density) / 100) * (maxSpacing - minSpacing);
        }

        // Inset the bounding box slightly (smaller inset for better coverage)
        const inset = 0.2;

        // Generate lines based on angle
        if (angle === 90) {
            // Vertical lines (90 degrees)
            const minX = bbox.minX + inset;
            const maxX = bbox.maxX - inset;
            const fillWidth = maxX - minX;
            const numLines = Math.ceil(fillWidth / spacing); // Use ceil to include last line

            for (let i = 0; i <= numLines; i++) {
                const x = minX + (i * spacing);
                if (x > maxX + 0.01) break; // Small tolerance for floating point

                // Find all intersection points with all perimeter paths for this vertical line
                const allIntersections = [];

                if (paths) {
                    for (const path of paths) {
                        const intersections = this.findVerticalLinePolygonIntersections(x, path);
                        allIntersections.push(...intersections);
                    }
                }

                // Sort intersections from bottom to top
                allIntersections.sort((a, b) => a - b);

                // Pair intersections to create fill segments
                // Check each segment to ensure it's actually in solid geometry (not in holes)
                for (let j = 0; j < allIntersections.length; j += 2) {
                    if (j + 1 < allIntersections.length) {
                        const startY = allIntersections[j];
                        const endY = allIntersections[j + 1];

                        // Check midpoint of segment to ensure it's in solid geometry
                        const midY = (startY + endY) / 2;
                        const midpoint = { x: x, y: midY };

                        // Only generate line if segment is long enough AND midpoint is in solid geometry
                        if (Math.abs(endY - startY) > 0.1 && this.isPointInSolidGeometry(midpoint, paths)) {
                            if (i % 2 === 0) {
                                gcode.push(`G0 X${x.toFixed(3)} Y${startY.toFixed(3)}`);
                                gcode.push(`G1 X${x.toFixed(3)} Y${endY.toFixed(3)} E0 F1500`);
                            } else {
                                gcode.push(`G0 X${x.toFixed(3)} Y${endY.toFixed(3)}`);
                                gcode.push(`G1 X${x.toFixed(3)} Y${startY.toFixed(3)} E0 F1500`);
                            }
                        }
                    }
                }
            }
        } else {
            // Horizontal lines (0 degrees)
            const minY = bbox.minY + inset;
            const maxY = bbox.maxY - inset;
            const fillHeight = maxY - minY;
            const numLines = Math.ceil(fillHeight / spacing); // Use ceil to include last line

            for (let i = 0; i <= numLines; i++) {
                const y = minY + (i * spacing);
                if (y > maxY + 0.01) break; // Small tolerance for floating point

            // Find all intersection points with all perimeter paths
            const allIntersections = [];

            if (paths) {
                for (const path of paths) {
                    const intersections = this.findLinePolygonIntersections(y, path);
                    allIntersections.push(...intersections);
                }
            }

            // Sort intersections from left to right
            allIntersections.sort((a, b) => a - b);

            // Pair intersections to create fill segments
            // Check each segment to ensure it's actually in solid geometry (not in holes)
            for (let j = 0; j < allIntersections.length; j += 2) {
                if (j + 1 < allIntersections.length) {
                    const startX = allIntersections[j];
                    const endX = allIntersections[j + 1];

                    // Check midpoint of segment to ensure it's in solid geometry
                    const midX = (startX + endX) / 2;
                    const midpoint = { x: midX, y: y };

                    // Only generate line if segment is long enough AND midpoint is in solid geometry
                    if (Math.abs(endX - startX) > 0.1 && this.isPointInSolidGeometry(midpoint, paths)) {
                        if (i % 2 === 0) {
                            gcode.push(`G0 X${startX.toFixed(3)} Y${y.toFixed(3)}`);
                            gcode.push(`G1 X${endX.toFixed(3)} Y${y.toFixed(3)} E0 F1500`);
                        } else {
                            gcode.push(`G0 X${endX.toFixed(3)} Y${y.toFixed(3)}`);
                            gcode.push(`G1 X${startX.toFixed(3)} Y${y.toFixed(3)} E0 F1500`);
                        }
                    }
                }
            }
            }
        }

        return gcode;
    }
}
