# 3D Printer Simulator

An interactive 3D printer simulator built with Babylon.js. Learn how FDM 3D printing works by generating shapes, slicing them into G-code, and watching the print process layer by layer.

## Features

- **Learning Mode** - Generate cubes, cylinders, and pyramids with one click, then step through each layer to understand how 3D printing works
- **Standard Mode** - Load STL files from your computer or URL, position/rotate/scale models on the build plate, and slice with full control over settings
- **Real-time G-code visualization** - Watch the print head move and extrude filament in 3D
- **Slicer settings** - Adjust layer height, infill pattern/density, quality presets, and filament type
- **Interactive 3D gizmos** - Drag to move, rotate, and scale models directly in the viewport
- **Export** - Save models as STL or GLB files
- **Help system** - Built-in contextual help explains 3D printing concepts

## Tech Stack

- [Babylon.js](https://www.babylonjs.com/) - 3D rendering engine
- Vanilla JavaScript - No build step required
- Custom G-code parser, generator, and STL slicer

## File Structure

```
js/
  main.js              - Application controller
  PrinterSimulator.js  - Babylon.js 3D renderer
  STLSlicer.js         - STL file parser and slicer
  GCodeGenerator.js    - G-code generation from sliced data
  GCodeParser.js       - G-code parsing and interpretation
css/
  style.css            - Dark theme styles
samples/
  cube.gcode           - Sample G-code file
```

## License

This project is licensed under the GNU General Public License v3.0 - see the [LICENSE](LICENSE) file for details.
