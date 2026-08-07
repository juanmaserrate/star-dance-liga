/* Star Dance - Aurora Shader Background (adapted from Stitch ANIMATION_14) */
(function () {
  var canvas = document.getElementById('shader-canvas-bg');
  if (!canvas) return;

  function syncSize() {
    var w = canvas.clientWidth || 1280;
    var h = canvas.clientHeight || 720;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(syncSize).observe(canvas);
  }
  syncSize();

  var gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
  if (!gl) return;

  var vs = 'attribute vec2 a_position;\n' +
    'varying vec2 v_texCoord;\n' +
    'void main() {\n' +
    '  v_texCoord = a_position * 0.5 + 0.5;\n' +
    '  gl_Position = vec4(a_position, 0.0, 1.0);\n' +
    '}';

  var fs = 'precision highp float;\n' +
    'uniform float u_time;\n' +
    'uniform vec2 u_resolution;\n' +
    'uniform vec2 u_mouse;\n' +
    'varying vec2 v_texCoord;\n' +
    '\n' +
    'vec3 permute(vec3 x) { return mod(((x*34.0)+1.0)*x, 289.0); }\n' +
    'float snoise(vec2 v) {\n' +
    '  const vec4 C = vec4(0.211324865405187, 0.366025403784439,\n' +
    '           -0.577350269189626, 0.024390243902439);\n' +
    '  vec2 i  = floor(v + dot(v, C.yy) );\n' +
    '  vec2 x0 = v -   i + dot(i, C.xx);\n' +
    '  vec2 i1;\n' +
    '  i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);\n' +
    '  vec4 x12 = x0.xyxy + C.xxzz;\n' +
    '  x12.xy -= i1;\n' +
    '  i = mod(i, 289.0);\n' +
    '  vec3 p = permute( permute( i.y + vec3(0.0, i1.y, 1.0 ))\n' +
    '  + i.x + vec3(0.0, i1.x, 1.0 ));\n' +
    '  vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy),\n' +
    '    dot(x12.zw,x12.zw)), 0.0);\n' +
    '  m = m*m ;\n' +
    '  m = m*m ;\n' +
    '  vec3 x = 2.0 * fract(p * C.www) - 1.0;\n' +
    '  vec3 h = abs(x) - 0.5;\n' +
    '  vec3 a0 = x - floor(x + 0.5);\n' +
    '  vec3 g = a0 * vec3(m.x, x12.x, x12.z) + h * vec3(m.y, x12.y, x12.w);\n' +
    '  float n = 130.0 * dot(m, g);\n' +
    '  return n;\n' +
    '}\n' +
    '\n' +
    'void main() {\n' +
    '    vec2 uv = v_texCoord;\n' +
    '    vec3 color1 = vec3(0.07, 0.08, 0.08); // Surface\n' +
    '    vec3 color2 = vec3(0.29, 0.14, 0.40); // Deep purple/violet\n' +
    '    vec3 gold = vec3(0.83, 0.69, 0.22);   // Gold accent\n' +
    '    float noise1 = snoise(uv * 2.0 + u_time * 0.1);\n' +
    '    float noise2 = snoise(uv * 4.0 - u_time * 0.05);\n' +
    '    float mask = smoothstep(-0.5, 0.5, noise1 + noise2 * 0.5);\n' +
    '    vec3 finalColor = mix(color1, color2, mask);\n' +
    '    float shimmer = smoothstep(0.45, 0.5, snoise(uv * 10.0 + u_time * 0.2));\n' +
    '    finalColor = mix(finalColor, gold, shimmer * 0.05);\n' +
    '    gl_FragColor = vec4(finalColor, 1.0);\n' +
    '}';

  function cs(type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return s;
  }
  var prog = gl.createProgram();
  gl.attachShader(prog, cs(gl.VERTEX_SHADER, vs));
  gl.attachShader(prog, cs(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(prog);
  gl.useProgram(prog);
  var buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  var pos = gl.getAttribLocation(prog, 'a_position');
  gl.enableVertexAttribArray(pos);
  gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);
  var uTime = gl.getUniformLocation(prog, 'u_time');
  var uRes = gl.getUniformLocation(prog, 'u_resolution');
  var uMouse = gl.getUniformLocation(prog, 'u_mouse');

  var mouse = { x: canvas.width / 2, y: canvas.height / 2 };
  window.addEventListener('mousemove', function (event) {
    var rect = canvas.getBoundingClientRect();
    if (rect.width && rect.height) {
      var nx = (event.clientX - rect.left) / rect.width;
      var ny = 1.0 - (event.clientY - rect.top) / rect.height;
      mouse.x = nx * canvas.width;
      mouse.y = ny * canvas.height;
    }
  });

  var reduced = typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function render(t) {
    if (typeof ResizeObserver === 'undefined') syncSize();
    gl.viewport(0, 0, canvas.width, canvas.height);
    if (uTime) gl.uniform1f(uTime, t * 0.001);
    if (uRes) gl.uniform2f(uRes, canvas.width, canvas.height);
    if (uMouse) gl.uniform2f(uMouse, mouse.x, mouse.y);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (!reduced) requestAnimationFrame(render);
  }
  render(0);
})();
