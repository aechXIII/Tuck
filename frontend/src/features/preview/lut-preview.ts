export interface LutPreview {
  set(table: Float32Array, size: number, strength: number): void;
  clear(): void;
  dispose(): void;
}

const vertexSource = `#version 300 es
out vec2 uv;
void main() {
  vec2 point = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  uv = vec2(point.x, 1.0 - point.y);
  gl_Position = vec4(point * 2.0 - 1.0, 0.0, 1.0);
}`;

const fragmentSource = `#version 300 es
precision highp float;
precision highp sampler3D;
uniform sampler2D sourceFrame;
uniform sampler3D lut;
uniform int size;
uniform float strength;
in vec2 uv;
out vec4 color;
void main() {
  vec3 source = texture(sourceFrame, uv).rgb;
  vec3 position = clamp(source, 0.0, 1.0) * float(size - 1);
  ivec3 low = ivec3(floor(position));
  ivec3 high = min(low + 1, ivec3(size - 1));
  vec3 weight = fract(position);
  vec3 bottom = mix(
    mix(texelFetch(lut, ivec3(low.x, low.y, low.z), 0).rgb,
        texelFetch(lut, ivec3(high.x, low.y, low.z), 0).rgb, weight.x),
    mix(texelFetch(lut, ivec3(low.x, high.y, low.z), 0).rgb,
        texelFetch(lut, ivec3(high.x, high.y, low.z), 0).rgb, weight.x), weight.y);
  vec3 top = mix(
    mix(texelFetch(lut, ivec3(low.x, low.y, high.z), 0).rgb,
        texelFetch(lut, ivec3(high.x, low.y, high.z), 0).rgb, weight.x),
    mix(texelFetch(lut, ivec3(low.x, high.y, high.z), 0).rgb,
        texelFetch(lut, ivec3(high.x, high.y, high.z), 0).rgb, weight.x), weight.y);
  color = vec4(mix(source, mix(bottom, top, weight.z), strength), 1.0);
}`;

export function createLutPreview(
  video: HTMLVideoElement,
  reportError: (message: string) => void,
): LutPreview {
  const canvas = video.ownerDocument.createElement("canvas");
  canvas.dataset.lutPreview = "";
  canvas.setAttribute("aria-hidden", "true");
  canvas.hidden = true;
  canvas.style.pointerEvents = "none";
  canvas.style.position = "absolute";
  canvas.style.display = "none";
  video.after(canvas);
  let gl: WebGL2RenderingContext | null = null;
  let program: WebGLProgram | null = null;
  let frameTexture: WebGLTexture | null = null;
  let lutTexture: WebGLTexture | null = null;
  let uploadedTable: Float32Array | null = null;
  let uploadedSize = 0;
  let currentStrength = 0;
  let active = false;
  let disposed = false;
  let frameCallback: number | null = null;
  let animationCallback: number | null = null;

  function stopFrames(): void {
    if (frameCallback !== null) video.cancelVideoFrameCallback(frameCallback);
    if (animationCallback !== null) cancelAnimationFrame(animationCallback);
    frameCallback = animationCallback = null;
  }

  function hideFrame(): void {
    canvas.hidden = true;
    canvas.style.display = "none";
    stopFrames();
    scheduleFrame();
  }

  function retainFrame(): void {
    stopFrames();
    scheduleFrame();
  }

  function clear(): void {
    active = false;
    uploadedTable = null;
    hideFrame();
  }

  function fail(message: string): void {
    clear();
    reportError(message);
  }

  function release(): void {
    if (gl) {
      gl.deleteTexture(frameTexture);
      gl.deleteTexture(lutTexture);
      gl.deleteProgram(program);
    }
    frameTexture = lutTexture = null;
    uploadedTable = null;
    program = null;
  }

  function initialize(): WebGL2RenderingContext {
    // paused previews must survive compositor paints without another video frame
    gl ??= canvas.getContext("webgl2", { alpha: false, antialias: false, depth: false, preserveDrawingBuffer: true });
    if (!gl || gl.isContextLost()) throw new Error("WebGL2 is unavailable");
    if (program) return gl;
    const context = gl;
    const shaders: WebGLShader[] = [];
    try {
      program = context.createProgram();
      if (!program) throw new Error("Could not create preview program");
      for (const [type, source] of [[context.VERTEX_SHADER, vertexSource], [context.FRAGMENT_SHADER, fragmentSource]] as const) {
        const shader = context.createShader(type);
        if (!shader) throw new Error("Could not create preview shader");
        shaders.push(shader);
        context.shaderSource(shader, source);
        context.compileShader(shader);
        if (!context.getShaderParameter(shader, context.COMPILE_STATUS)) throw new Error("Could not compile preview shader");
        context.attachShader(program, shader);
      }
      context.linkProgram(program);
      if (!context.getProgramParameter(program, context.LINK_STATUS)) throw new Error("Could not link preview shader");
      frameTexture = context.createTexture();
      lutTexture = context.createTexture();
      if (!frameTexture || !lutTexture) throw new Error("Could not allocate preview textures");
      context.useProgram(program);
      context.uniform1i(context.getUniformLocation(program, "sourceFrame"), 0);
      context.uniform1i(context.getUniformLocation(program, "lut"), 1);
      context.activeTexture(context.TEXTURE0);
      context.bindTexture(context.TEXTURE_2D, frameTexture);
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.LINEAR);
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, context.LINEAR);
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_S, context.CLAMP_TO_EDGE);
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_T, context.CLAMP_TO_EDGE);
      context.activeTexture(context.TEXTURE1);
      context.bindTexture(context.TEXTURE_3D, lutTexture);
      // manual interpolation keeps float textures usable without filtering extensions
      context.texParameteri(context.TEXTURE_3D, context.TEXTURE_MIN_FILTER, context.NEAREST);
      context.texParameteri(context.TEXTURE_3D, context.TEXTURE_MAG_FILTER, context.NEAREST);
      context.texParameteri(context.TEXTURE_3D, context.TEXTURE_WRAP_S, context.CLAMP_TO_EDGE);
      context.texParameteri(context.TEXTURE_3D, context.TEXTURE_WRAP_T, context.CLAMP_TO_EDGE);
      context.texParameteri(context.TEXTURE_3D, context.TEXTURE_WRAP_R, context.CLAMP_TO_EDGE);
      return context;
    } catch (error) {
      release();
      throw error;
    } finally {
      for (const shader of shaders) context.deleteShader(shader);
    }
  }

  function syncGeometry(): void {
    const style = getComputedStyle(video);
    for (const property of ["left", "top", "width", "height", "transform", "transform-origin", "object-fit", "object-position", "visibility", "opacity", "display", "clip-path", "border-radius"]) {
      canvas.style.setProperty(property, style.getPropertyValue(property));
    }
    const bounds = video.getBoundingClientRect();
    const scale = Math.min(1, 1920 / Math.max(video.videoWidth, video.videoHeight),
      Math.max(1, bounds.width, bounds.height) * devicePixelRatio / Math.max(1, video.videoWidth, video.videoHeight));
    const width = Math.max(1, Math.round(video.videoWidth * scale));
    const height = Math.max(1, Math.round(video.videoHeight * scale));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
  }

  function draw(): void {
    if (!active || disposed || !gl || gl.isContextLost() || video.seeking || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth) return;
    try {
      syncGeometry();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, frameTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, video);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (gl.getError() !== gl.NO_ERROR) throw new Error("Could not draw preview frame");
      canvas.hidden = false;
    } catch {
      fail("LUT preview could not read this video. Try reopening it. The LUT still applies to export.");
    }
  }

  function scheduleFrame(): void {
    if (!active || disposed) return;
    if (!video.paused && !video.ended) {
      // software compositors can expose video callbacks without delivering them
      if (frameCallback !== null) video.cancelVideoFrameCallback(frameCallback);
      frameCallback = null;
      if (animationCallback !== null) return;
      animationCallback = requestAnimationFrame(() => {
        animationCallback = null;
        draw();
        scheduleFrame();
      });
    } else if (frameCallback === null && typeof video.requestVideoFrameCallback === "function") {
      // paused seeks and clip loads can present a frame after their media events
      frameCallback = video.requestVideoFrameCallback(() => {
        frameCallback = null;
        draw();
        scheduleFrame();
      });
    }
  }

  function refresh(): void { draw(); scheduleFrame(); }
  function pause(): void {
    if (animationCallback !== null) cancelAnimationFrame(animationCallback);
    animationCallback = null;
    refresh();
  }
  function emptied(): void {
    if (video.getAttribute("src") || video.srcObject) retainFrame();
    else hideFrame();
  }
  function contextLost(event: Event): void {
    event.preventDefault();
    release();
    fail("LUT preview stopped because graphics resources were lost. Turn the LUT off and on to retry.");
  }
  const resize = new ResizeObserver(refresh);
  resize.observe(video);
  if (video.parentElement) resize.observe(video.parentElement);
  const mutations = new MutationObserver(refresh);
  mutations.observe(video, { attributes: true, attributeFilter: ["style", "class", "hidden"] });
  for (const event of ["loadeddata", "seeked", "playing", "resize"]) video.addEventListener(event, refresh);
  for (const event of ["pause", "ended"]) video.addEventListener(event, pause);
  video.addEventListener("loadstart", retainFrame);
  video.addEventListener("emptied", emptied);
  video.addEventListener("error", hideFrame);
  canvas.addEventListener("webglcontextlost", contextLost);

  return {
    set(table, size, strength) {
      if (disposed) return;
      if (active && table === uploadedTable && size === uploadedSize && strength === currentStrength) return;
      if (!Number.isInteger(size) || size < 2 || size > 65 || table.length !== size ** 3 * 3 ||
          !Number.isFinite(strength) || strength < 0 || strength > 1 ||
          (table !== uploadedTable && table.some(value => !Number.isFinite(value) || value < 0 || value > 1))) {
        fail("LUT preview data is invalid. Import the LUT again.");
        return;
      }
      if (strength === 0) { clear(); return; }
      try {
        const context = initialize();
        if (table !== uploadedTable || size !== uploadedSize) {
          context.activeTexture(context.TEXTURE1);
          context.bindTexture(context.TEXTURE_3D, lutTexture);
          context.pixelStorei(context.UNPACK_ALIGNMENT, 1);
          context.texImage3D(context.TEXTURE_3D, 0, context.RGB32F, size, size, size, 0, context.RGB, context.FLOAT, table);
          context.uniform1i(context.getUniformLocation(program!, "size"), size);
        }
        context.uniform1f(context.getUniformLocation(program!, "strength"), strength);
        if (context.getError() !== context.NO_ERROR) throw new Error("Could not upload LUT");
        uploadedTable = table;
        uploadedSize = size;
        currentStrength = strength;
        active = true;
        refresh();
      } catch {
        fail("LUT preview is unavailable on this graphics device. The LUT still applies to export.");
      }
    },
    clear,
    dispose() {
      if (disposed) return;
      clear();
      disposed = true;
      resize.disconnect();
      mutations.disconnect();
      for (const event of ["loadeddata", "seeked", "playing", "resize"]) video.removeEventListener(event, refresh);
      for (const event of ["pause", "ended"]) video.removeEventListener(event, pause);
      video.removeEventListener("loadstart", retainFrame);
      video.removeEventListener("emptied", emptied);
      video.removeEventListener("error", hideFrame);
      canvas.removeEventListener("webglcontextlost", contextLost);
      release();
      canvas.remove();
    },
  };
}
