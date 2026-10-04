import {
  DEFAULT_VISUALS,
  particleRadius,
  trailOpacity,
  visualMode,
  colorMode,
  type VisualSettings,
} from "./visuals";
// One GPU point draw for all particles. Context creation failure uses Canvas 2D.
export class ParticleRenderer {
  private gl: WebGLRenderingContext;
  private program: WebGLProgram;
  private positions: WebGLBuffer;
  private types: WebGLBuffer;
  private aPosition: number;
  private aType: number;
  private speeds: WebGLBuffer;
  private aSpeed: number;
  private composition: WebGLBuffer;
  private aComposition: number;
  private viewKey = "";
  private count = 0;
  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl", {
      alpha: false,
      antialias: false,
      preserveDrawingBuffer: true,
    });
    if (!gl) throw new Error("WebGL unavailable");
    this.gl = gl;
    const shader = (kind: number, source: string) => {
      const s = gl.createShader(kind)!;
      gl.shaderSource(s, source);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
        throw new Error(gl.getShaderInfoLog(s) || "Shader error");
      return s;
    };
    const vs = shader(
      gl.VERTEX_SHADER,
      `precision mediump float; attribute vec2 position; attribute float species; attribute float speed; attribute vec4 composition; uniform float mixed; uniform float colorMode; uniform vec2 resolution; uniform vec2 origin; uniform float side; uniform float pointSize; uniform float mode; varying vec3 color;
 void main(){vec2 p=mode>0.5?position:(origin+position*side)/resolution*2.0-1.0;gl_Position=vec4(p.x,mode>0.5?p.y:-p.y,0.,1.);gl_PointSize=pointSize;color=species<.5?vec3(.447,.898,.737):species<1.5?vec3(.941,.741,.443):species<2.5?vec3(.6,.612,.965):vec3(.929,.518,.616);if(mixed>.5){color=composition.x*vec3(.447,.898,.737)+composition.y*vec3(.941,.741,.443)+composition.z*vec3(.6,.612,.965)+composition.w*vec3(.929,.518,.616);}if(colorMode>1.5){color=vec3(.82,.93,1.);}else if(colorMode>.5){float t=speed/(1.+speed);color=vec3(.15+.85*t,.55+.2*t,1.-.9*t);}}`,
    );
    const fs = shader(
      gl.FRAGMENT_SHADER,
      `precision mediump float;uniform float mode;uniform float opacity;uniform float effect;uniform float intensity;varying vec3 color;void main(){if(mode>1.5){gl_FragColor=vec4(.125,.188,.216,1.);return;}if(mode>.5){gl_FragColor=vec4(.03137,.06275,.07843,opacity);return;}float d=length(gl_PointCoord-vec2(.5));if(d>.5)discard;d*=2.;float a=1.-smoothstep(.6,1.,d);if(effect>2.5){a=exp(-4.*d*d)*(1.-smoothstep(.8,1.,d))*.09*intensity;}else if(effect>1.5){a=smoothstep(.48,.65,d)*(1.-smoothstep(.8,1.,d));}else if(effect>.5){a=(exp(-7.*d*d)+.4*(1.-smoothstep(.05,.22,d)))*(1.-smoothstep(.8,1.,d))*intensity;}gl_FragColor=vec4(color,clamp(a,0.,1.));}`,
    );
    const program = gl.createProgram()!;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error(gl.getProgramInfoLog(program) || "Shader link failed");
    this.program = program;
    this.positions = gl.createBuffer()!;
    this.types = gl.createBuffer()!;
    this.speeds = gl.createBuffer()!;
    this.composition = gl.createBuffer()!;
    this.aComposition = gl.getAttribLocation(program, "composition");
    this.aSpeed = gl.getAttribLocation(program, "speed");
    this.aPosition = gl.getAttribLocation(program, "position");
    this.aType = gl.getAttribLocation(program, "species");
  }
  draw(
    p: Float32Array,
    types: Uint8Array,
    width: number,
    height: number,
    side: number,
    left: number,
    top: number,
    zoom: number,
    trails: boolean,
    visuals: VisualSettings = DEFAULT_VISUALS,
    speeds?: Float32Array,
    advancing = true,
    composition?: Float32Array,
  ) {
    const gl = this.gl;
    if (gl.isContextLost()) return false;
    const dpr = Math.min(devicePixelRatio || 1, 2),
      w = Math.round(width * dpr),
      h = Math.round(height * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      trails = false;
    }
    const key = JSON.stringify([width, height, side, left, top, visuals]);
    const reset = !trails || key !== this.viewKey;
    this.viewKey = key;
    if (!reset && !advancing) return true;
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.program);
    const uniform = (name: string, value: number) =>
      gl.uniform1f(gl.getUniformLocation(this.program, name), value);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positions);
    gl.enableVertexAttribArray(this.aPosition);
    gl.vertexAttribPointer(this.aPosition, 2, gl.FLOAT, false, 0, 0);
    gl.disableVertexAttribArray(this.aComposition);
    gl.vertexAttrib4f(this.aComposition, 0, 0, 0, 0);
    gl.disableVertexAttribArray(this.aSpeed);
    gl.vertexAttrib1f(this.aSpeed, 0);
    gl.disableVertexAttribArray(this.aType);
    gl.vertexAttrib1f(this.aType, 0);
    uniform("mode", 1);
    uniform("opacity", reset ? 1 : trailOpacity(visuals));
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      gl.STREAM_DRAW,
    );
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    uniform("mode", 2);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([
        (left / width) * 2 - 1,
        1 - (top / height) * 2,
        ((left + side) / width) * 2 - 1,
        1 - (top / height) * 2,
        ((left + side) / width) * 2 - 1,
        1 - ((top + side) / height) * 2,
        (left / width) * 2 - 1,
        1 - ((top + side) / height) * 2,
      ]),
      gl.STREAM_DRAW,
    );
    gl.drawArrays(gl.LINE_LOOP, 0, 4);
    uniform("mode", 0);
    uniform("pointSize", 2 * particleRadius(zoom, visuals) * dpr);
    uniform("effect", visualMode(visuals));
    uniform("colorMode", colorMode(visuals));
    uniform("intensity", visuals.intensity);
    uniform("mixed", composition ? 1 : 0);
    if (visuals.mode === "glow" || visuals.mode === "field")
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    gl.uniform2f(
      gl.getUniformLocation(this.program, "resolution"),
      width,
      height,
    );
    gl.uniform2f(gl.getUniformLocation(this.program, "origin"), left, top);
    uniform("side", side);
    gl.bufferData(gl.ARRAY_BUFFER, p, gl.STREAM_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.types);
    if (this.count !== types.length) {
      gl.bufferData(gl.ARRAY_BUFFER, types, gl.STATIC_DRAW);
      this.count = types.length;
    }
    gl.enableVertexAttribArray(this.aType);
    gl.vertexAttribPointer(this.aType, 1, gl.UNSIGNED_BYTE, false, 0, 0);
    if (visuals.color === "speed" && speeds) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.speeds);
      gl.bufferData(gl.ARRAY_BUFFER, speeds, gl.STREAM_DRAW);
      gl.enableVertexAttribArray(this.aSpeed);
      gl.vertexAttribPointer(this.aSpeed, 1, gl.FLOAT, false, 0, 0);
    }
    if (composition) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.composition);
      gl.bufferData(gl.ARRAY_BUFFER, composition, gl.STREAM_DRAW);
      gl.enableVertexAttribArray(this.aComposition);
      gl.vertexAttribPointer(this.aComposition, 4, gl.FLOAT, false, 0, 0);
    }
    gl.drawArrays(gl.POINTS, 0, types.length);
    return true;
  }
  destroy() {
    const gl = this.gl;
    gl.deleteBuffer(this.positions);
    gl.deleteBuffer(this.types);
    gl.deleteBuffer(this.speeds);
    gl.deleteBuffer(this.composition);
    gl.deleteProgram(this.program);
  }
}
