// Entry point bundled into src/vendor/paper-shaders.js.
// We pull in only the pieces the drawer background needs so tree-shaking can
// drop the other ~30 shaders in the package (853KB unpacked) on the floor.
export { ShaderMount } from '@paper-design/shaders';
export { meshGradientFragmentShader } from '@paper-design/shaders';
export { staticMeshGradientFragmentShader } from '@paper-design/shaders';
export { getShaderColorFromString } from '@paper-design/shaders';
export { ShaderFitOptions, defaultObjectSizing } from '@paper-design/shaders';
