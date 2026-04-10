// ═══════════════════════════════════════════════════════════════
//  HAND PEN — Neural Particle Engine
//  Main Application Script
// ═══════════════════════════════════════════════════════════════

// ─── CONFIGURATION ───────────────────────────────────────────
const CFG = {
  particles: 6000,
  shapes: ['SPHERE', 'SPIRAL', 'TORUS', 'HEART', 'DNA'],
  autoSwitchMs: 9000,
  morphTime: 2.0,
  repulseRadius: 3.8,
  repulseForce: 0.14,
  friction: 0.91,
  lerpSpeed: 0.04,
  cameraDist: 9,
  cameraRotSpeed: 0.07,
  penColor: '#00f0ff',
  penWidth: 3,
  zoomSensitivity: 60,
};
const N = CFG.particles;

// ─── STATE ───────────────────────────────────────────────────
let penEnabled = false;       // Pen starts OFF
let autoOn = true;
let autoTimer = null;
let shapeIdx = 0;
let morphProg = 1;
let fistDebounce = 0;
let shapeDebounce = 0;
let explodeForce = 0;
let orbitAngleX = 0, orbitAngleY = 0;
let lastOrbitX = null, lastOrbitY = null;
let autoRotate = true;
let targetZoom = CFG.cameraDist;
let prevPinchDist = null;     // For delta-based zoom
let prevDualPinchDist = null;
let drawing = false;
let lastPt = null;
let allHands = [];
let handCount = 0;
let prevGesture = 'none';

// ─── ONE EURO FILTER (for smooth pen tracking) ──────────────
class OneEuroFilter {
  constructor(freq = 30, minCutoff = 1.0, beta = 0.007, dCutoff = 1.0) {
    this.freq = freq;
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.xPrev = null;
    this.dxPrev = 0;
    this.tPrev = null;
  }
  _alpha(cutoff) {
    const te = 1.0 / this.freq;
    const tau = 1.0 / (2 * Math.PI * cutoff);
    return 1.0 / (1.0 + tau / te);
  }
  filter(x, t) {
    if (this.xPrev === null) {
      this.xPrev = x;
      this.tPrev = t;
      return x;
    }
    const dt = t - this.tPrev;
    if (dt > 0) this.freq = 1.0 / dt;
    this.tPrev = t;
    const adx = this._alpha(this.dCutoff);
    const dx = (x - this.xPrev) * this.freq;
    this.dxPrev = adx * dx + (1 - adx) * this.dxPrev;
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dxPrev);
    const a = this._alpha(cutoff);
    this.xPrev = a * x + (1 - a) * this.xPrev;
    return this.xPrev;
  }
  reset() { this.xPrev = null; this.dxPrev = 0; this.tPrev = null; }
}
// Two filters: one for X, one for Y (low beta = more smoothing for writing)
const penFilterX = new OneEuroFilter(30, 1.5, 0.005, 1.0);
const penFilterY = new OneEuroFilter(30, 1.5, 0.005, 1.0);

// ─── THREE.JS SETUP ─────────────────────────────────────────
const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x050505, 0.04);
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 100);
camera.position.set(0, 0, CFG.cameraDist);
const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setClearColor(0x050505);
renderer.domElement.id = 'scene';
document.body.prepend(renderer.domElement);

// ─── PARTICLE SHADERS ───────────────────────────────────────
const vShader = `
  attribute float size; attribute vec3 customColor; attribute float alpha;
  varying vec3 vC; varying float vA;
  void main(){
    vC = customColor; vA = alpha;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = size * (280.0 / -mv.z);
    gl_Position = projectionMatrix * mv;
  }`;
const fShader = `
  varying vec3 vC; varying float vA;
  void main(){
    float d = length(gl_PointCoord - vec2(0.5));
    if(d > 0.5) discard;
    float g = pow(1.0 - smoothstep(0.0, 0.5, d), 1.8);
    gl_FragColor = vec4(vC * 1.4, g * vA);
  }`;

// ─── PARTICLE SYSTEM ────────────────────────────────────────
const geo = new THREE.BufferGeometry();
const pos = new Float32Array(N * 3);
const col = new Float32Array(N * 3);
const sz = new Float32Array(N);
const al = new Float32Array(N);
const tgt = new Float32Array(N * 3);
const vel = new Float32Array(N * 3);

const cCyan = new THREE.Color(0x00f0ff);
const cPurp = new THREE.Color(0xa855f7);
const cPink = new THREE.Color(0xff2d95);
for (let i = 0; i < N; i++) {
  const t = i / N, c = new THREE.Color();
  t < 0.5 ? c.lerpColors(cCyan, cPurp, t * 2) : c.lerpColors(cPurp, cPink, (t - 0.5) * 2);
  col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  sz[i] = 1.5 + Math.random() * 2;
  al[i] = 0.6 + Math.random() * 0.4;
}
geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
geo.setAttribute('customColor', new THREE.BufferAttribute(col, 3));
geo.setAttribute('size', new THREE.BufferAttribute(sz, 1));
geo.setAttribute('alpha', new THREE.BufferAttribute(al, 1));
const mat = new THREE.ShaderMaterial({
  vertexShader: vShader, fragmentShader: fShader,
  blending: THREE.AdditiveBlending, depthTest: false, transparent: true
});
const pts = new THREE.Points(geo, mat);
scene.add(pts);

// ─── SHAPE GENERATORS ───────────────────────────────────────
const PHI = (1 + Math.sqrt(5)) / 2;
function genSphere(n, r = 4) {
  const p = [];
  for (let i = 0; i < n; i++) {
    const th = 2 * Math.PI * i / PHI;
    const ph = Math.acos(1 - 2 * (i + 0.5) / n);
    p.push(r * Math.sin(ph) * Math.cos(th), r * Math.cos(ph), r * Math.sin(ph) * Math.sin(th));
  }
  return p;
}
function genSpiral(n) {
  const p = [];
  for (let i = 0; i < n; i++) {
    const t = i / n, a = t * Math.PI * 14, r = 0.3 + t * 4;
    const y = (Math.random() - 0.5) * (1.2 - t * 0.8) * 1.5;
    p.push(r * Math.cos(a) + (Math.random() - .5) * .25, y, r * Math.sin(a) + (Math.random() - .5) * .25);
  }
  return p;
}
function genTorus(n, R = 3, r = 1.2) {
  const p = [];
  for (let i = 0; i < n; i++) {
    const u = Math.random() * Math.PI * 2, v = Math.random() * Math.PI * 2;
    p.push((R + r * Math.cos(v)) * Math.cos(u), r * Math.sin(v), (R + r * Math.cos(v)) * Math.sin(u));
  }
  return p;
}
function genHeart(n) {
  const p = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const x = 16 * Math.pow(Math.sin(t), 3);
    const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
    const z = (Math.random() - 0.5) * 6;
    p.push(x * .22, y * .22, z * .22);
  }
  return p;
}
function genDNA(n) {
  const p = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 8, y = (i / n - 0.5) * 10, s = i % 3;
    if (s < 2) { const o = s === 0 ? 0 : Math.PI; p.push(2 * Math.cos(t + o), y, 2 * Math.sin(t + o)); }
    else { const r = 2 * Math.random(); p.push(r * Math.cos(t), y, r * Math.sin(t)); }
  }
  return p;
}
const gens = { SPHERE: genSphere, SPIRAL: genSpiral, TORUS: genTorus, HEART: genHeart, DNA: genDNA };

function setShape(name) {
  const p = gens[name](N);
  for (let i = 0; i < N * 3; i++) tgt[i] = p[i];
  morphProg = 0;
  document.getElementById('shape-name').textContent = name;
}
function nextShape() {
  shapeIdx = (shapeIdx + 1) % CFG.shapes.length;
  setShape(CFG.shapes[shapeIdx]);
  flash(CFG.shapes[shapeIdx]);
}
function startAuto() {
  if (autoTimer) clearInterval(autoTimer);
  autoTimer = setInterval(nextShape, CFG.autoSwitchMs);
  autoOn = true;
  document.getElementById('auto-status').textContent = '● AUTO-CYCLE ON';
  document.getElementById('auto-status').style.color = '#39ff14';
}
function stopAuto() {
  if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
  autoOn = false;
  document.getElementById('auto-status').textContent = '○ AUTO-CYCLE OFF';
  document.getElementById('auto-status').style.color = '#ff2d9580';
}

// Init first shape
setShape('SPHERE');
for (let i = 0; i < N * 3; i++) pos[i] = tgt[i] + (Math.random() - 0.5) * 10;
startAuto();

// ─── DRAWING CANVAS ─────────────────────────────────────────
const dCv = document.createElement('canvas');
dCv.id = 'draw-canvas';
dCv.width = innerWidth; dCv.height = innerHeight;
document.body.appendChild(dCv);
const dCtx = dCv.getContext('2d');

// Smoothed bezier drawing for better letter quality
let pointBuffer = []; // Buffer last few points for bezier

function addDrawPoint(x, y) {
  pointBuffer.push({ x, y });
  if (pointBuffer.length < 3) return;

  // Use quadratic bezier through last 3 points
  const p0 = pointBuffer[pointBuffer.length - 3];
  const p1 = pointBuffer[pointBuffer.length - 2];
  const p2 = pointBuffer[pointBuffer.length - 1];
  const midX = (p1.x + p2.x) / 2;
  const midY = (p1.y + p2.y) / 2;

  dCtx.strokeStyle = CFG.penColor;
  dCtx.lineWidth = CFG.penWidth;
  dCtx.lineCap = 'round';
  dCtx.lineJoin = 'round';
  dCtx.shadowColor = CFG.penColor;
  dCtx.shadowBlur = 14;
  dCtx.beginPath();
  dCtx.moveTo((p0.x + p1.x) / 2, (p0.y + p1.y) / 2);
  dCtx.quadraticCurveTo(p1.x, p1.y, midX, midY);
  dCtx.stroke();

  // Glow layer
  dCtx.shadowBlur = 28;
  dCtx.lineWidth = CFG.penWidth * 0.4;
  dCtx.globalAlpha = 0.3;
  dCtx.stroke();
  dCtx.globalAlpha = 1;
  dCtx.shadowBlur = 0;

  // Keep buffer at max 10 points
  if (pointBuffer.length > 10) pointBuffer = pointBuffer.slice(-5);
}

function clearDraw() {
  dCtx.clearRect(0, 0, dCv.width, dCv.height);
  lastPt = null;
  pointBuffer = [];
  flash('CLEARED');
}

// ─── PEN TOGGLE ──────────────────────────────────────────────
function togglePen() {
  penEnabled = !penEnabled;
  const btn = document.getElementById('pen-toggle');
  if (penEnabled) {
    btn.textContent = 'PEN ON ✏';
    btn.classList.add('pen-on');
  } else {
    btn.textContent = 'PEN OFF';
    btn.classList.remove('pen-on');
    drawing = false;
    lastPt = null;
    pointBuffer = [];
    penFilterX.reset();
    penFilterY.reset();
  }
  flash(penEnabled ? 'PEN ACTIVATED' : 'PEN DEACTIVATED');
}
// Expose globally for onclick
window.togglePen = togglePen;

function setPC(el) {
  document.querySelectorAll('.cdot').forEach(d => d.classList.remove('on'));
  el.classList.add('on');
  CFG.penColor = el.dataset.c;
}
window.setPC = setPC;
window.clearDraw = clearDraw;

// ─── HAND TRACKING ──────────────────────────────────────────
const videoEl = document.getElementById('webcam');
const hCv = document.getElementById('hand-overlay');
const hCtx = hCv.getContext('2d');

async function initCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 320, height: 240, facingMode: 'user' }
    });
    videoEl.srcObject = stream;
    await videoEl.play();
    hCv.width = videoEl.videoWidth || 320;
    hCv.height = videoEl.videoHeight || 240;
    initMediaPipe();
  } catch (e) {
    console.warn('No camera:', e);
    document.getElementById('cam-box').style.display = 'none';
    document.getElementById('finger-info').style.display = 'none';
    document.getElementById('loading').classList.add('hide');
  }
}

function initMediaPipe() {
  const hands = new Hands({
    locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/${f}`
  });
  hands.setOptions({
    maxNumHands: 2,
    modelComplexity: 1,
    minDetectionConfidence: 0.6,
    minTrackingConfidence: 0.5
  });
  hands.onResults(onHandResults);

  async function loop() {
    if (videoEl.readyState >= 2) {
      try { await hands.send({ image: videoEl }); } catch (e) { }
    }
    requestAnimationFrame(loop);
  }

  hands.initialize().then(() => {
    document.getElementById('loading').classList.add('hide');
    loop();
  }).catch(() => {
    document.getElementById('loading').classList.add('hide');
  });
}

function onHandResults(results) {
  hCtx.clearRect(0, 0, hCv.width, hCv.height);
  allHands = [];
  if (results.multiHandLandmarks) {
    handCount = results.multiHandLandmarks.length;
    for (let h = 0; h < handCount; h++) {
      const lm = results.multiHandLandmarks[h];
      const label = (results.multiHandedness && results.multiHandedness[h])
        ? results.multiHandedness[h].label : 'Unknown';
      const fingers = getFingerStates(lm);
      const gesture = detectGesture(lm, fingers);
      allHands.push({ lm, label, fingers, gesture });
      drawAdvancedHand(lm, h);
    }
    // Update finger info panel using first hand
    if (handCount > 0) updateFingerPanel(allHands[0].fingers);
  } else {
    handCount = 0;
  }
  document.getElementById('hand-count').textContent = handCount + ' HAND' + (handCount !== 1 ? 'S' : '');
}

// ─── FINGER DETECTION (robust angle-based) ──────────────────
function dist3D(a, b) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + ((a.z || 0) - (b.z || 0)) ** 2);
}
function dist2D(a, b) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

// Compute angle at joint B between segments A-B and B-C
function jointAngle(a, b, c) {
  const v1 = { x: a.x - b.x, y: a.y - b.y };
  const v2 = { x: c.x - b.x, y: c.y - b.y };
  const dot = v1.x * v2.x + v1.y * v2.y;
  const m1 = Math.sqrt(v1.x ** 2 + v1.y ** 2);
  const m2 = Math.sqrt(v2.x ** 2 + v2.y ** 2);
  if (m1 * m2 < 0.0001) return Math.PI;
  return Math.acos(Math.max(-1, Math.min(1, dot / (m1 * m2))));
}

function getFingerStates(lm) {
  // Thumb: use distance-based (tip farther from palm than IP)
  const palmCenter = { x: (lm[0].x + lm[5].x + lm[17].x) / 3, y: (lm[0].y + lm[5].y + lm[17].y) / 3 };
  const thumbUp = dist2D(lm[4], palmCenter) > dist2D(lm[3], palmCenter) * 1.1;

  // Other fingers: angle at PIP joint — extended if angle > 2.6 rad (~150°)
  const indexAngle = jointAngle(lm[5], lm[6], lm[8]);
  const middleAngle = jointAngle(lm[9], lm[10], lm[12]);
  const ringAngle = jointAngle(lm[13], lm[14], lm[16]);
  const pinkyAngle = jointAngle(lm[17], lm[18], lm[20]);

  const threshold = 2.4; // radians (~137°)

  return {
    thumb: thumbUp,
    index: indexAngle > threshold,
    middle: middleAngle > threshold,
    ring: ringAngle > threshold,
    pinky: pinkyAngle > threshold,
    // Raw angles for debugging
    angles: {
      index: indexAngle,
      middle: middleAngle,
      ring: ringAngle,
      pinky: pinkyAngle
    }
  };
}

function updateFingerPanel(f) {
  const names = ['thumb', 'index', 'middle', 'ring', 'pinky'];
  names.forEach(name => {
    const row = document.getElementById('fi-' + name);
    const state = row.querySelector('.fi-state');
    const up = f[name];
    row.classList.toggle('active', up);
    state.textContent = up ? 'UP' : 'DOWN';
  });
}

// ─── GESTURE DETECTION ──────────────────────────────────────
function detectGesture(lm, f) {
  // Pinch: thumb tip close to index tip (regardless of other finger states)
  const pinchD = dist3D(lm[4], lm[8]);
  if (pinchD < 0.07 && !f.middle && !f.ring && !f.pinky) return 'pinch';

  // Two fingers: index + middle up, others down → orbit
  if (f.index && f.middle && !f.ring && !f.pinky) return 'orbit';

  // Index only → writing (if pen enabled)
  if (f.index && !f.middle && !f.ring && !f.pinky) return 'writing';

  // Fist: all down
  if (!f.index && !f.middle && !f.ring && !f.pinky && !f.thumb) return 'fist';

  // Open hand: all up
  if (f.index && f.middle && f.ring && f.pinky) return 'open';

  return 'none';
}

// ─── ADVANCED HAND WIREFRAME ────────────────────────────────
const CONNS = [
  [0, 1], [1, 2], [2, 3], [3, 4],         // thumb
  [0, 5], [5, 6], [6, 7], [7, 8],         // index
  [5, 9], [9, 10], [10, 11], [11, 12],    // middle
  [9, 13], [13, 14], [14, 15], [15, 16],  // ring
  [13, 17], [17, 18], [18, 19], [19, 20], // pinky
  [0, 17]                                  // palm base
];
const F_COLORS = ['#ff6b6b', '#00f0ff', '#39ff14', '#ffbe0b', '#a855f7'];
const F_GROUPS = [[0, 1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]];
const F_NAMES = ['THB', 'IDX', 'MID', 'RNG', 'PNK'];
const TIPS = [4, 8, 12, 16, 20];

function getFingerGroup(idx) {
  for (let f = 0; f < F_GROUPS.length; f++) if (F_GROUPS[f].includes(idx)) return f;
  return 0;
}

function drawAdvancedHand(lm, handIdx) {
  const w = hCv.width, h = hCv.height;

  // Palm polygon fill
  const palmIds = [0, 5, 9, 13, 17];
  hCtx.fillStyle = handIdx === 0 ? 'rgba(0,240,255,.05)' : 'rgba(168,85,247,.05)';
  hCtx.beginPath();
  palmIds.forEach((id, i) => {
    const x = lm[id].x * w, y = lm[id].y * h;
    i === 0 ? hCtx.moveTo(x, y) : hCtx.lineTo(x, y);
  });
  hCtx.closePath();
  hCtx.fill();

  // Bones — color-coded per finger, thicker near palm
  for (const [a, b] of CONNS) {
    const fi = getFingerGroup(b);
    const color = F_COLORS[fi];
    const isPalm = [0, 5, 9, 13, 17].includes(a);
    hCtx.strokeStyle = color;
    hCtx.lineWidth = isPalm ? 2.5 : 1.5;
    hCtx.shadowColor = color;
    hCtx.shadowBlur = 6;
    hCtx.globalAlpha = 0.85;
    hCtx.beginPath();
    hCtx.moveTo(lm[a].x * w, lm[a].y * h);
    hCtx.lineTo(lm[b].x * w, lm[b].y * h);
    hCtx.stroke();
  }
  hCtx.globalAlpha = 1;
  hCtx.shadowBlur = 0;

  // Joints
  for (let i = 0; i < 21; i++) {
    const x = lm[i].x * w, y = lm[i].y * h;
    const fi = getFingerGroup(i);
    const isTip = TIPS.includes(i);
    const r = isTip ? 4 : 2.5;

    if (isTip) {
      // Outer glow halo
      hCtx.beginPath();
      hCtx.arc(x, y, r + 5, 0, Math.PI * 2);
      hCtx.fillStyle = F_COLORS[fi] + '25';
      hCtx.fill();
    }
    // Joint dot
    hCtx.beginPath();
    hCtx.arc(x, y, r, 0, Math.PI * 2);
    hCtx.fillStyle = isTip ? '#fff' : F_COLORS[fi];
    hCtx.fill();
    // Inner highlight for tips
    if (isTip) {
      hCtx.beginPath();
      hCtx.arc(x, y, 1.5, 0, Math.PI * 2);
      hCtx.fillStyle = F_COLORS[fi];
      hCtx.fill();
    }
  }

  // Fingertip labels
  for (let f = 0; f < 5; f++) {
    const tipIdx = TIPS[f];
    const x = lm[tipIdx].x * w, y = lm[tipIdx].y * h;
    hCtx.font = '7px Orbitron, sans-serif';
    hCtx.fillStyle = F_COLORS[f];
    hCtx.fillText(F_NAMES[f], x + 7, y - 7);
  }
}

// ─── UI HELPERS ─────────────────────────────────────────────
let flashT;
function flash(t) {
  const e = document.getElementById('gesture-flash');
  e.textContent = t;
  e.style.opacity = '1';
  clearTimeout(flashT);
  flashT = setTimeout(() => e.style.opacity = '0', 1200);
}
function showMode(m) {
  const b = document.getElementById('mode-badge');
  b.className = 'glass show ' + m;
  const labels = { writing: '✏ WRITING', orbit: '🌐 3D ORBIT', particles: '✋ REPEL', dual: '⚡ DUAL MODE' };
  b.textContent = labels[m] || m;
}
function hideMode() { document.getElementById('mode-badge').classList.remove('show'); }

// ─── MOUSE FALLBACK ─────────────────────────────────────────
let mouse3D = new THREE.Vector3(999, 999, 999);
let mouseOn = false;
window.addEventListener('mousemove', e => {
  if (handCount > 0) return;
  mouseOn = true;
  mouse3D.set((e.clientX / innerWidth - 0.5) * 12, -(e.clientY / innerHeight - 0.5) * 10, 0);
});
window.addEventListener('mouseleave', () => mouseOn = false);
window.addEventListener('click', e => {
  if (handCount > 0 || e.target.closest('#draw-ctrl') || e.target.closest('#info')) return;
  nextShape();
});
window.addEventListener('wheel', e => {
  targetZoom = THREE.MathUtils.clamp(targetZoom + e.deltaY * 0.005, 3, 20);
});
// Keyboard shortcut: P to toggle pen
window.addEventListener('keydown', e => {
  if (e.key === 'p' || e.key === 'P') togglePen();
  if (e.key === 'c' || e.key === 'C') clearDraw();
});

// ─── ANIMATION LOOP ─────────────────────────────────────────
let time = 0, frames = 0, fpsT = 0;
const clock = new THREE.Clock();
const pA = geo.getAttribute('position');
const sA = geo.getAttribute('size');
const aA = geo.getAttribute('alpha');

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  time += dt;
  const now = performance.now() / 1000;

  // FPS
  frames++; fpsT += dt;
  if (fpsT >= 0.5) {
    document.getElementById('fps').textContent = Math.round(frames / fpsT) + ' FPS';
    frames = 0; fpsT = 0;
  }

  if (fistDebounce > 0) fistDebounce -= dt;
  if (shapeDebounce > 0) shapeDebounce -= dt;

  // ── PROCESS HANDS ──
  let repulsor = mouse3D.clone();
  let repulsorOn = mouseOn;
  let statusText = 'NO HAND DETECTED';
  let statusColor = '#ffffff40';
  let modeType = '';

  // Reset repulsion config each frame
  let frameRepR = CFG.repulseRadius;
  let frameRepF = CFG.repulseForce;
  explodeForce = 0;

  if (handCount === 0) {
    if (drawing) { drawing = false; lastPt = null; pointBuffer = []; penFilterX.reset(); penFilterY.reset(); }
    hideMode();
    prevPinchDist = null;
    prevDualPinchDist = null;
    // Reset finger panel
    ['thumb', 'index', 'middle', 'ring', 'pinky'].forEach(n => {
      const row = document.getElementById('fi-' + n);
      row.classList.remove('active');
      row.querySelector('.fi-state').textContent = '—';
    });
  }
  else if (handCount === 1) {
    const H = allHands[0];
    const lm = H.lm, g = H.gesture;
    const palm = lm[9];
    repulsor.set((0.5 - palm.x) * 14, -(palm.y - 0.5) * 10, -(palm.z) * 5);

    if (g === 'writing' && penEnabled) {
      statusText = '✏ WRITING'; statusColor = '#ff2d95'; modeType = 'writing';
      const tip = lm[8];
      // Apply One Euro Filter for smoothing
      const rawX = (1 - tip.x) * dCv.width;
      const rawY = tip.y * dCv.height;
      const sx = penFilterX.filter(rawX, now);
      const sy = penFilterY.filter(rawY, now);

      if (!drawing) {
        drawing = true;
        lastPt = { x: sx, y: sy };
        pointBuffer = [{ x: sx, y: sy }];
      } else {
        const d = Math.hypot(sx - lastPt.x, sy - lastPt.y);
        if (d > 1.5 && d < 150) {
          addDrawPoint(sx, sy);
        }
        lastPt = { x: sx, y: sy };
      }
      prevPinchDist = null;
    }
    else if (g === 'writing' && !penEnabled) {
      statusText = '☝ INDEX (pen off)'; statusColor = '#ffffff60';
      if (drawing) { drawing = false; lastPt = null; pointBuffer = []; penFilterX.reset(); penFilterY.reset(); }
      prevPinchDist = null;
    }
    else if (g === 'orbit') {
      statusText = '🌐 3D ORBIT'; statusColor = '#39ff14'; modeType = 'orbit';
      if (drawing) { drawing = false; lastPt = null; pointBuffer = []; penFilterX.reset(); penFilterY.reset(); }
      const midX = (lm[8].x + lm[12].x) / 2;
      const midY = (lm[8].y + lm[12].y) / 2;
      if (lastOrbitX !== null) {
        orbitAngleX += (midX - lastOrbitX) * 8;
        orbitAngleY = THREE.MathUtils.clamp(orbitAngleY + (midY - lastOrbitY) * 5, -1.2, 1.2);
        autoRotate = false;
      }
      lastOrbitX = midX; lastOrbitY = midY;
      prevPinchDist = null;
    }
    else if (g === 'open') {
      statusText = '✋ REPELLING'; statusColor = '#00f0ff'; modeType = 'particles';
      if (drawing) { drawing = false; lastPt = null; pointBuffer = []; penFilterX.reset(); penFilterY.reset(); }
      repulsorOn = true;
      lastOrbitX = null; lastOrbitY = null;
      prevPinchDist = null;
    }
    else if (g === 'pinch') {
      // Delta-based pinch zoom: in = zoom in, out = zoom out
      const currentPD = dist3D(lm[4], lm[8]);
      if (prevPinchDist !== null) {
        const delta = currentPD - prevPinchDist;
        // Spreading = zoom in (closer), pinching = zoom out (farther)
        targetZoom = THREE.MathUtils.clamp(targetZoom - delta * CFG.zoomSensitivity, 3, 20);
      }
      prevPinchDist = currentPD;
      statusText = '🤏 ZOOM ' + (targetZoom < CFG.cameraDist ? 'IN' : 'OUT');
      statusColor = '#a855f7';
      if (drawing) { drawing = false; lastPt = null; pointBuffer = []; penFilterX.reset(); penFilterY.reset(); }
      lastOrbitX = null; lastOrbitY = null;
    }
    else if (g === 'fist') {
      statusText = '✊ FIST'; statusColor = '#ffbe0b';
      if (drawing) { drawing = false; lastPt = null; pointBuffer = []; penFilterX.reset(); penFilterY.reset(); }
      if (prevGesture !== 'fist' && fistDebounce <= 0) {
        if (autoOn) { stopAuto(); flash('AUTO-CYCLE STOPPED'); }
        fistDebounce = 1.5;
      }
      lastOrbitX = null; lastOrbitY = null;
      prevPinchDist = null;
    }
    else {
      if (drawing) { drawing = false; lastPt = null; pointBuffer = []; penFilterX.reset(); penFilterY.reset(); }
      statusText = 'TRACKING...'; statusColor = '#ffffff60';
      lastOrbitX = null; lastOrbitY = null;
      prevPinchDist = null;
    }
    if (g !== 'orbit') { lastOrbitX = null; lastOrbitY = null; }
    prevGesture = g;
    prevDualPinchDist = null;
  }
  else if (handCount === 2) {
    const H1 = allHands[0], H2 = allHands[1];
    const g1 = H1.gesture, g2 = H2.gesture;
    if (drawing) { drawing = false; lastPt = null; pointBuffer = []; penFilterX.reset(); penFilterY.reset(); }
    prevPinchDist = null;

    if (g1 === 'open' && g2 === 'open') {
      statusText = '💥 EXPLODE'; statusColor = '#ff2d95'; modeType = 'dual';
      const p1 = H1.lm[9], p2 = H2.lm[9];
      const hd = dist3D(p1, p2);
      explodeForce = THREE.MathUtils.mapLinear(hd, 0.1, 0.8, 0, 0.3);
      repulsor.set((0.5 - (p1.x + p2.x) / 2) * 14, -((p1.y + p2.y) / 2 - 0.5) * 10, 0);
      repulsorOn = true;
      frameRepF = 0.3; frameRepR = 6;
      prevDualPinchDist = null;
    }
    else if (g1 === 'pinch' && g2 === 'pinch') {
      // Both pinch: delta zoom based on distance between two thumbs
      const dd = dist3D(H1.lm[4], H2.lm[4]);
      if (prevDualPinchDist !== null) {
        const delta = dd - prevDualPinchDist;
        targetZoom = THREE.MathUtils.clamp(targetZoom - delta * CFG.zoomSensitivity * 0.8, 3, 20);
      }
      prevDualPinchDist = dd;
      statusText = '🔍 FINE ZOOM'; statusColor = '#a855f7'; modeType = 'dual';
    }
    else if ((g1 === 'fist' && g2 === 'open') || (g1 === 'open' && g2 === 'fist')) {
      statusText = '⏭ NEXT SHAPE'; statusColor = '#39ff14'; modeType = 'dual';
      if (shapeDebounce <= 0) { nextShape(); shapeDebounce = 2; }
      prevDualPinchDist = null;
    }
    else {
      statusText = `2 HANDS: ${g1} + ${g2}`; statusColor = '#ffffff60';
      lastOrbitX = null; lastOrbitY = null;
      prevDualPinchDist = null;
    }
  }

  document.getElementById('gesture-status').textContent = statusText;
  document.getElementById('gesture-status').style.color = statusColor;
  if (modeType) showMode(modeType); else if (handCount > 0) hideMode();

  // ── CAMERA ──
  camera.position.z += (targetZoom - camera.position.z) * 0.04;
  if (autoRotate) {
    const ca = time * CFG.cameraRotSpeed;
    camera.position.x = Math.sin(ca) * 1.5;
    camera.position.y = Math.cos(ca * 0.7) * 0.8;
  } else {
    const r = camera.position.z;
    camera.position.x = Math.sin(orbitAngleX) * Math.cos(orbitAngleY) * r;
    camera.position.y = Math.sin(orbitAngleY) * r;
    camera.position.z = Math.cos(orbitAngleX) * Math.cos(orbitAngleY) * r;
  }
  camera.lookAt(0, 0, 0);

  // ── PARTICLES ──
  morphProg = Math.min(morphProg + dt / CFG.morphTime, 1);
  const la = CFG.lerpSpeed + morphProg * 0.02;
  for (let i = 0; i < N; i++) {
    const i3 = i * 3;
    vel[i3] += (tgt[i3] - pos[i3]) * la;
    vel[i3 + 1] += (tgt[i3 + 1] - pos[i3 + 1]) * la;
    vel[i3 + 2] += (tgt[i3 + 2] - pos[i3 + 2]) * la;

    if (explodeForce > 0) {
      const ex = pos[i3], ey = pos[i3 + 1], ez = pos[i3 + 2];
      const ed = Math.sqrt(ex * ex + ey * ey + ez * ez) + 0.01;
      vel[i3] += ex / ed * explodeForce;
      vel[i3 + 1] += ey / ed * explodeForce;
      vel[i3 + 2] += ez / ed * explodeForce;
    }

    if (repulsorOn) {
      const rx = pos[i3] - repulsor.x, ry = pos[i3 + 1] - repulsor.y, rz = pos[i3 + 2] - repulsor.z;
      const rd = Math.sqrt(rx * rx + ry * ry + rz * rz) + 0.001;
      if (rd < frameRepR) {
        const f = (1 - rd / frameRepR) * frameRepF;
        vel[i3] += rx / rd * f;
        vel[i3 + 1] += ry / rd * f;
        vel[i3 + 2] += rz / rd * f;
      }
    }

    vel[i3] *= CFG.friction; vel[i3 + 1] *= CFG.friction; vel[i3 + 2] *= CFG.friction;
    pos[i3] += vel[i3]; pos[i3 + 1] += vel[i3 + 1]; pos[i3 + 2] += vel[i3 + 2];
    pos[i3 + 1] += Math.sin(time * 1.5 + i * 0.01) * 0.003;

    const spd = Math.abs(vel[i3]) + Math.abs(vel[i3 + 1]) + Math.abs(vel[i3 + 2]);
    al[i] = THREE.MathUtils.clamp(0.5 + spd * 8, 0.4, 1);
    sz[i] = THREE.MathUtils.clamp(1.5 + spd * 20, 1.5, 5);
  }
  pA.needsUpdate = true; sA.needsUpdate = true; aA.needsUpdate = true;
  pts.rotation.y = time * 0.03;
  renderer.render(scene, camera);
}

// ─── RESIZE ─────────────────────────────────────────────────
window.addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  const img = dCtx.getImageData(0, 0, dCv.width, dCv.height);
  dCv.width = innerWidth; dCv.height = innerHeight;
  dCtx.putImageData(img, 0, 0);
});

// ─── INIT ───────────────────────────────────────────────────
initCamera();
setTimeout(() => document.getElementById('loading').classList.add('hide'), 8000);
animate();
