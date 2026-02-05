/**
 * G-code Parser for 3D Printer Simulator
 * Parses basic G-code commands for movement and extrusion
 */
class GCodeParser {
    constructor() {
        this.commands = [];
        this.currentPosition = { x: 0, y: 0, z: 0, e: 0 };
        this.currentTemp = 0;
        this.layerHeight = 0.2; // Default layer height
        this.layers = [];
    }

    /**
     * Parse G-code text into command objects
     */
    parse(gcodeText) {
        this.commands = [];
        this.layers = [];
        this.currentPosition = { x: 0, y: 0, z: 0, e: 0 };

        const lines = gcodeText.split('\n');
        let currentLayer = 0;
        let lastZ = 0;

        // First pass: check if G-code has layer comments
        let hasLayerComments = false;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line.match(/;\s*layer[:\s]+\d+/i)) {
                hasLayerComments = true;
                break;
            }
        }

        // Second pass: parse commands
        lines.forEach((line, index) => {
            line = line.trim();

            // Skip empty lines and comments
            if (!line || line.startsWith(';')) {
                // Check for layer comments (e.g., "; Layer 1 (Z=0.20)")
                if (line.toLowerCase().includes('layer')) {
                    const match = line.match(/layer[:\s]+(\d+)/i);
                    if (match) {
                        currentLayer = parseInt(match[1]);
                    }
                }
                return;
            }

            // Remove inline comments
            line = line.split(';')[0].trim();
            if (!line) return;

            const command = this.parseLine(line, index, currentLayer);
            if (command) {
                // Only detect layer changes based on Z movement if no layer comments exist
                // This prevents double-counting when G-code has explicit layer markers
                if (!hasLayerComments && command.type === 'move' && command.z !== undefined && command.z !== lastZ) {
                    currentLayer++;
                    lastZ = command.z;
                }

                command.layer = currentLayer;
                this.commands.push(command);

                // Track layers - but skip layer 0 when using layer comments
                // (layer 0 is just setup commands before actual printing starts)
                if (!this.layers.includes(currentLayer) && !(hasLayerComments && currentLayer === 0)) {
                    this.layers.push(currentLayer);
                }
            }
        });

        console.log(`Parsed ${this.commands.length} commands, ${this.layers.length} layers`);
        return this.commands;
    }

    /**
     * Parse a single G-code line
     */
    parseLine(line, lineNumber, currentLayer) {
        const parts = line.split(/\s+/);
        const cmdCode = parts[0].toUpperCase();

        // Parse parameters
        const params = {};
        for (let i = 1; i < parts.length; i++) {
            const param = parts[i];
            const letter = param[0].toUpperCase();
            const value = parseFloat(param.substring(1));
            if (!isNaN(value)) {
                params[letter] = value;
            }
        }

        // Handle different G-code commands
        switch (cmdCode) {
            case 'G0':  // Rapid move (non-printing)
            case 'G1':  // Linear move (printing if E is present)
                return this.parseMove(cmdCode, params, lineNumber);

            case 'G28': // Home axis
                return { type: 'home', axes: params, line: lineNumber };

            case 'M104': // Set extruder temperature
            case 'M109': // Set extruder temperature and wait
                this.currentTemp = params.S || 0;
                return { type: 'temperature', temp: this.currentTemp, line: lineNumber };

            case 'M140': // Set bed temperature
            case 'M190': // Set bed temperature and wait
                return { type: 'bed_temperature', temp: params.S || 0, line: lineNumber };

            default:
                return null;
        }
    }

    /**
     * Parse movement command (G0/G1)
     */
    parseMove(cmdCode, params, lineNumber) {
        const move = {
            type: 'move',
            line: lineNumber,
            from: { ...this.currentPosition },
            to: { ...this.currentPosition }
        };

        // Update position based on parameters
        if (params.X !== undefined) {
            move.to.x = params.X;
            move.x = params.X;
        }
        if (params.Y !== undefined) {
            move.to.y = params.Y;
            move.y = params.Y;
        }
        if (params.Z !== undefined) {
            move.to.z = params.Z;
            move.z = params.Z;
        }
        if (params.E !== undefined) {
            move.to.e = params.E;
            move.e = params.E;
        }

        // Determine if this is an extrusion move
        move.extruding = params.E !== undefined && params.E > this.currentPosition.e;

        // Store feedrate if present
        if (params.F !== undefined) {
            move.feedrate = params.F;
        }

        this.currentPosition = { ...move.to };

        return move;
    }

    /**
     * Get total number of layers
     */
    getLayerCount() {
        return this.layers.length;
    }

    /**
     * Get commands for a specific layer
     */
    getLayerCommands(layerNum) {
        return this.commands.filter(cmd => cmd.layer === layerNum);
    }

    /**
     * Get bounding box of the print
     */
    getBoundingBox() {
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

        this.commands.forEach(cmd => {
            if (cmd.type === 'move') {
                if (cmd.to.x < minX) minX = cmd.to.x;
                if (cmd.to.y < minY) minY = cmd.to.y;
                if (cmd.to.z < minZ) minZ = cmd.to.z;
                if (cmd.to.x > maxX) maxX = cmd.to.x;
                if (cmd.to.y > maxY) maxY = cmd.to.y;
                if (cmd.to.z > maxZ) maxZ = cmd.to.z;
            }
        });

        return {
            min: { x: minX, y: minY, z: minZ },
            max: { x: maxX, y: maxY, z: maxZ },
            size: {
                x: maxX - minX,
                y: maxY - minY,
                z: maxZ - minZ
            }
        };
    }
}
