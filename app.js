// ═══════════════════════════════════════════════════════════════
//  HAND PEN — Neural Particle Engine v3
// ═══════════════════════════════════════════════════════════════

const CFG = {
  N: 6000, shapes: ['SPHERE','SPIRAL','TORUS','HEART','DNA'],
  autoMs: 9000, morphT: 2, repR: 3.8, repF: 0.14,
  friction: 0.91, lerp: 0.04, camDist: 9,
  penColor: '#00f0ff', penW: 3, zoomSens: 50
};
const N = CFG.N;

// ── STATE ──
let penOn = false, autoOn = true, autoTimer = null;
let shapeIdx = 0, morphProg = 1;
let shape2Idx = -1, morph2Prog = 1, shape2Active = false;
let fistDb = 0, shapeDb = 0, smashDb = 0;
let orbitTheta = 0, orbitPhi = 0.3, orbitR = CFG.camDist;
let lastOrbitX = null, lastOrbitY = null;
let targetZoom = CFG.camDist;
let prevPinchD = null, prevDualPinchD = null, prev2FingerD = null;
let drawing = false, lastPt = null, pointBuf = [];
let allHands = [], handCount = 0, prevGesture = 'none';
let camVisible = false; // camera starts hidden
let voiceOn = false, recognition = null;
let eraserOn = false;
let fistHistory = [];
let tapTimes = [];
let activeTarget = 'shape1'; // shape1, shape2, both
let explodeForce = 0;
let autoRotateAngle = 0;

// ── ONE EURO FILTER ──
class OEF {
  constructor(fc=30,mc=1.5,b=0.005,dc=1){this.fc=fc;this.mc=mc;this.b=b;this.dc=dc;this.xp=null;this.dxp=0;this.tp=null;}
  a(c){const te=1/this.fc,tau=1/(2*Math.PI*c);return 1/(1+tau/te);}
  f(x,t){
    if(this.xp===null){this.xp=x;this.tp=t;return x;}
    const dt=t-this.tp;if(dt>0)this.fc=1/dt;this.tp=t;
    const ad=this.a(this.dc),dx=(x-this.xp)*this.fc;
    this.dxp=ad*dx+(1-ad)*this.dxp;
    const c=this.mc+this.b*Math.abs(this.dxp),al=this.a(c);
    this.xp=al*x+(1-al)*this.xp;return this.xp;
  }
  r(){this.xp=null;this.dxp=0;this.tp=null;}
}
const pfX=new OEF(),pfY=new OEF();

// ── THREE.JS ──
const scene=new THREE.Scene();
scene.fog=new THREE.FogExp2(0x000000,0.035);
const camera=new THREE.PerspectiveCamera(60,innerWidth/innerHeight,0.1,100);
camera.position.set(0,0,CFG.camDist);
const ren=new THREE.WebGLRenderer({antialias:false});
ren.setSize(innerWidth,innerHeight);
ren.setPixelRatio(Math.min(devicePixelRatio,2));
ren.setClearColor(0x000000);
ren.domElement.id='scene';
document.body.prepend(ren.domElement);

const vS=`attribute float size;attribute vec3 customColor;attribute float alpha;varying vec3 vC;varying float vA;void main(){vC=customColor;vA=alpha;vec4 mv=modelViewMatrix*vec4(position,1.0);gl_PointSize=size*(280.0/-mv.z);gl_Position=projectionMatrix*mv;}`;
const fS=`varying vec3 vC;varying float vA;void main(){float d=length(gl_PointCoord-vec2(0.5));if(d>0.5)discard;float g=pow(1.0-smoothstep(0.0,0.5,d),1.8);gl_FragColor=vec4(vC*1.4,g*vA);}`;

// ── PARTICLE SYSTEM FACTORY ──
function makeParticles(hueShift){
  const g=new THREE.BufferGeometry();
  const p=new Float32Array(N*3),c=new Float32Array(N*3),s=new Float32Array(N),a=new Float32Array(N);
  const t=new Float32Array(N*3),v=new Float32Array(N*3);
  const c1=new THREE.Color(0x00f0ff),c2=new THREE.Color(0xa855f7),c3=new THREE.Color(0xff2d95);
  for(let i=0;i<N;i++){
    const f=i/N,cl=new THREE.Color();
    f<.5?cl.lerpColors(c1,c2,f*2):cl.lerpColors(c2,c3,(f-.5)*2);
    if(hueShift){const hsl={};cl.getHSL(hsl);cl.setHSL((hsl.h+hueShift)%1,hsl.s,hsl.l);}
    c[i*3]=cl.r;c[i*3+1]=cl.g;c[i*3+2]=cl.b;
    s[i]=1.5+Math.random()*2;a[i]=.6+Math.random()*.4;
  }
  g.setAttribute('position',new THREE.BufferAttribute(p,3));
  g.setAttribute('customColor',new THREE.BufferAttribute(c,3));
  g.setAttribute('size',new THREE.BufferAttribute(s,1));
  g.setAttribute('alpha',new THREE.BufferAttribute(a,1));
  const m=new THREE.ShaderMaterial({vertexShader:vS,fragmentShader:fS,blending:THREE.AdditiveBlending,depthTest:false,transparent:true});
  const pts=new THREE.Points(g,m);
  return {geo:g,pos:p,col:c,sz:s,al:a,tgt:t,vel:v,pts,pA:g.getAttribute('position'),sA:g.getAttribute('size'),aA:g.getAttribute('alpha')};
}

const S1=makeParticles(0);   // Primary shape
const S2=makeParticles(0.3); // Secondary (hue-shifted)
scene.add(S1.pts);
S2.pts.visible=false;
S2.pts.position.x=5; // offset second shape
scene.add(S2.pts);

// ── SHAPES ──
const PHI=(1+Math.sqrt(5))/2;
function genSphere(n,r=4){const p=[];for(let i=0;i<n;i++){const t=2*Math.PI*i/PHI,ph=Math.acos(1-2*(i+.5)/n);p.push(r*Math.sin(ph)*Math.cos(t),r*Math.cos(ph),r*Math.sin(ph)*Math.sin(t));}return p;}
function genSpiral(n){const p=[];for(let i=0;i<n;i++){const t=i/n,a=t*Math.PI*14,r=.3+t*4,y=(Math.random()-.5)*(1.2-t*.8)*1.5;p.push(r*Math.cos(a)+(Math.random()-.5)*.25,y,r*Math.sin(a)+(Math.random()-.5)*.25);}return p;}
function genTorus(n,R=3,r=1.2){const p=[];for(let i=0;i<n;i++){const u=Math.random()*Math.PI*2,v=Math.random()*Math.PI*2;p.push((R+r*Math.cos(v))*Math.cos(u),r*Math.sin(v),(R+r*Math.cos(v))*Math.sin(u));}return p;}
function genHeart(n){const p=[];for(let i=0;i<n;i++){const t=(i/n)*Math.PI*2,x=16*Math.pow(Math.sin(t),3),y=13*Math.cos(t)-5*Math.cos(2*t)-2*Math.cos(3*t)-Math.cos(4*t),z=(Math.random()-.5)*6;p.push(x*.22,y*.22,z*.22);}return p;}
function genDNA(n){const p=[];for(let i=0;i<n;i++){const t=(i/n)*Math.PI*8,y=(i/n-.5)*10,s=i%3;if(s<2){const o=s===0?0:Math.PI;p.push(2*Math.cos(t+o),y,2*Math.sin(t+o));}else{const r=2*Math.random();p.push(r*Math.cos(t),y,r*Math.sin(t));}}return p;}
const gens={SPHERE:genSphere,SPIRAL:genSpiral,TORUS:genTorus,HEART:genHeart,DNA:genDNA};

function setShape(sys,name,idx){
  const p=gens[name](N);for(let i=0;i<N*3;i++)sys.tgt[i]=p[i];
  if(sys===S1){morphProg=0;document.getElementById('shape-name').textContent=name;}
  else{morph2Prog=0;document.getElementById('shape2-name').textContent='SHAPE 2: '+name;}
}
function nextShape(){shapeIdx=(shapeIdx+1)%CFG.shapes.length;setShape(S1,CFG.shapes[shapeIdx]);flash(CFG.shapes[shapeIdx]);}
function nextShape2(){shape2Idx=(shape2Idx+1)%CFG.shapes.length;setShape(S2,CFG.shapes[shape2Idx]);flash('S2: '+CFG.shapes[shape2Idx]);}
function startAuto(){if(autoTimer)clearInterval(autoTimer);autoTimer=setInterval(nextShape,CFG.autoMs);autoOn=true;document.getElementById('auto-status').textContent='● AUTO-CYCLE ON';document.getElementById('auto-status').style.color='#39ff14';}
function stopAuto(){if(autoTimer){clearInterval(autoTimer);autoTimer=null;}autoOn=false;document.getElementById('auto-status').textContent='○ AUTO-CYCLE OFF';document.getElementById('auto-status').style.color='#ff2d9580';}

setShape(S1,'SPHERE');
for(let i=0;i<N*3;i++)S1.pos[i]=S1.tgt[i]+(Math.random()-.5)*10;
startAuto();

// ── DRAW CANVAS ──
const dCv=document.createElement('canvas');dCv.id='draw-canvas';dCv.width=innerWidth;dCv.height=innerHeight;
document.body.appendChild(dCv);const dCtx=dCv.getContext('2d');

function addDrawPoint(x,y){
  pointBuf.push({x,y});if(pointBuf.length<3)return;
  const p0=pointBuf[pointBuf.length-3],p1=pointBuf[pointBuf.length-2],p2=pointBuf[pointBuf.length-1];
  dCtx.strokeStyle=eraserOn?'#000':CFG.penColor;
  dCtx.lineWidth=eraserOn?20:CFG.penW;
  dCtx.lineCap='round';dCtx.lineJoin='round';
  dCtx.globalCompositeOperation=eraserOn?'destination-out':'source-over';
  dCtx.shadowColor=eraserOn?'transparent':CFG.penColor;dCtx.shadowBlur=eraserOn?0:14;
  dCtx.beginPath();dCtx.moveTo((p0.x+p1.x)/2,(p0.y+p1.y)/2);
  dCtx.quadraticCurveTo(p1.x,p1.y,(p1.x+p2.x)/2,(p1.y+p2.y)/2);dCtx.stroke();
  if(!eraserOn){dCtx.shadowBlur=28;dCtx.lineWidth=CFG.penW*.4;dCtx.globalAlpha=.3;dCtx.stroke();dCtx.globalAlpha=1;}
  dCtx.shadowBlur=0;dCtx.globalCompositeOperation='source-over';
  if(pointBuf.length>10)pointBuf=pointBuf.slice(-5);
}
function clearDraw(){dCtx.clearRect(0,0,dCv.width,dCv.height);lastPt=null;pointBuf=[];flash('CLEARED');}
window.clearDraw=clearDraw;

function togglePen(){
  penOn=!penOn;const b=document.getElementById('pen-toggle');
  b.textContent=penOn?'PEN ON ✏':'PEN OFF';b.classList.toggle('pen-on',penOn);
  if(!penOn){drawing=false;lastPt=null;pointBuf=[];pfX.r();pfY.r();eraserOn=false;}
  flash(penOn?'PEN ON':'PEN OFF');
}
window.togglePen=togglePen;
function setPC(el){document.querySelectorAll('.cdot').forEach(d=>d.classList.remove('on'));el.classList.add('on');CFG.penColor=el.dataset.c;}
window.setPC=setPC;

// ── CAMERA VISIBILITY ──
function showCam(){camVisible=true;document.getElementById('cam-box').classList.remove('cam-hidden');document.getElementById('finger-info').classList.remove('cam-hidden');flash('CAMERA ON');}
function hideCam(){camVisible=false;document.getElementById('cam-box').classList.add('cam-hidden');document.getElementById('finger-info').classList.add('cam-hidden');flash('CAMERA OFF');}

// ── VOICE COMMANDS ──
function initVoice(){
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!SR){console.warn('No Speech API');return;}
  recognition=new SR();recognition.continuous=true;recognition.interimResults=false;recognition.lang='en-US';
  recognition.onresult=e=>{
    const t=e.results[e.results.length-1][0].transcript.toLowerCase().trim();
    processVoice(t);
  };
  recognition.onerror=()=>{};
  recognition.onend=()=>{if(voiceOn)try{recognition.start();}catch(e){}};
}
function toggleVoice(){
  voiceOn=!voiceOn;const vs=document.getElementById('voice-status');
  if(voiceOn){try{recognition.start();}catch(e){}vs.classList.add('listening');document.getElementById('voice-text').textContent='Listening...';}
  else{try{recognition.stop();}catch(e){}vs.classList.remove('listening');document.getElementById('voice-text').textContent='Voice OFF';}
}
function processVoice(t){
  flash('🎙 "'+t+'"');
  if(t.includes('show')&&t.includes('screen'))showCam();
  else if(t.includes('dismiss'))hideCam();
  else if(t.includes('pen on')){if(!penOn)togglePen();}
  else if(t.includes('pen off')){if(penOn)togglePen();}
  else if(t.includes('clear'))clearDraw();
  else if(t.includes('next shape'))nextShape();
  else if(t.includes('zoom in')){targetZoom=Math.max(3,targetZoom-3);}
  else if(t.includes('zoom out')){targetZoom=Math.min(20,targetZoom+3);}
  else if(t.includes('second shape'))spawnShape2();
  else if(t.includes('eraser')){eraserOn=!eraserOn;flash(eraserOn?'ERASER ON':'ERASER OFF');}
  else if(t.includes('stop'))stopAuto();
  else if(t.includes('start'))startAuto();
  else if(t.includes('reset')){location.reload();}
}
document.getElementById('voice-status').addEventListener('click',()=>toggleVoice());

function spawnShape2(){
  if(!shape2Active){shape2Active=true;shape2Idx=1;S2.pts.visible=true;
    setShape(S2,CFG.shapes[shape2Idx]);
    for(let i=0;i<N*3;i++)S2.pos[i]=S2.tgt[i]+(Math.random()-.5)*10;
    document.getElementById('shape2-name').style.display='block';
    flash('SHAPE 2 SPAWNED');
  }else{nextShape2();}
}

// ── HAND TRACKING ──
const videoEl=document.getElementById('webcam'),hCv=document.getElementById('hand-overlay'),hCtx=hCv.getContext('2d');

async function initCamera(){
  try{
    const stream=await navigator.mediaDevices.getUserMedia({video:{width:320,height:240,facingMode:'user'}});
    videoEl.srcObject=stream;await videoEl.play();
    hCv.width=videoEl.videoWidth||320;hCv.height=videoEl.videoHeight||240;
    initMP();
  }catch(e){document.getElementById('loading').classList.add('hide');}
}
function initMP(){
  const hands=new Hands({locateFile:f=>`https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/${f}`});
  hands.setOptions({maxNumHands:2,modelComplexity:1,minDetectionConfidence:0.6,minTrackingConfidence:0.5});
  hands.onResults(onRes);
  async function loop(){if(videoEl.readyState>=2)try{await hands.send({image:videoEl});}catch(e){}requestAnimationFrame(loop);}
  hands.initialize().then(()=>{document.getElementById('loading').classList.add('hide');loop();}).catch(()=>{document.getElementById('loading').classList.add('hide');});
}
function onRes(res){
  hCtx.clearRect(0,0,hCv.width,hCv.height);allHands=[];
  if(res.multiHandLandmarks){
    handCount=res.multiHandLandmarks.length;
    for(let h=0;h<handCount;h++){
      const lm=res.multiHandLandmarks[h];
      const lb=(res.multiHandedness&&res.multiHandedness[h])?res.multiHandedness[h].label:'Unknown';
      const fi=getFingers(lm),g=detectG(lm,fi);
      allHands.push({lm,lb,fi,g});drawHand(lm,h);
    }
    if(handCount>0)updateFP(allHands[0].fi);
  }else handCount=0;
  document.getElementById('hand-count').textContent=handCount+' HAND'+(handCount!==1?'S':'');
}

// ── ROBUST FINGER DETECTION ──
function d3(a,b){return Math.sqrt((a.x-b.x)**2+(a.y-b.y)**2+((a.z||0)-(b.z||0))**2);}
function d2(a,b){return Math.sqrt((a.x-b.x)**2+(a.y-b.y)**2);}
function jAngle(a,b,c){const v1={x:a.x-b.x,y:a.y-b.y},v2={x:c.x-b.x,y:c.y-b.y};const dot=v1.x*v2.x+v1.y*v2.y;const m=Math.sqrt(v1.x**2+v1.y**2)*Math.sqrt(v2.x**2+v2.y**2);return m<.0001?Math.PI:Math.acos(Math.max(-1,Math.min(1,dot/m)));}

function getFingers(lm){
  const pc={x:(lm[0].x+lm[5].x+lm[17].x)/3,y:(lm[0].y+lm[5].y+lm[17].y)/3};
  const th=2.3; // strict angle threshold (~132°)
  return{
    thumb:d2(lm[4],pc)>d2(lm[3],pc)*1.15,
    index:jAngle(lm[5],lm[6],lm[8])>th,
    middle:jAngle(lm[9],lm[10],lm[12])>th,
    ring:jAngle(lm[13],lm[14],lm[16])>th,
    pinky:jAngle(lm[17],lm[18],lm[20])>th
  };
}
function updateFP(f){
  ['thumb','index','middle','ring','pinky'].forEach(n=>{
    const r=document.getElementById('fi-'+n),s=r.querySelector('.fi-state');
    r.classList.toggle('active',f[n]);s.textContent=f[n]?'UP':'DOWN';
  });
}

// ── GESTURE DETECTION (STRICT) ──
function detectG(lm,f){
  const pinchD=d3(lm[4],lm[8]);
  // Pinch: thumb+index close, middle/ring/pinky ALL down
  if(pinchD<0.07&&!f.middle&&!f.ring&&!f.pinky)return'pinch';
  // Two fingers: ONLY index+middle up
  if(f.index&&f.middle&&!f.ring&&!f.pinky)return'twoFinger';
  // Index only
  if(f.index&&!f.middle&&!f.ring&&!f.pinky)return'index';
  // STRICT fist: ALL five fingers down
  if(!f.thumb&&!f.index&&!f.middle&&!f.ring&&!f.pinky)return'fist';
  // Open: all four main fingers up
  if(f.index&&f.middle&&f.ring&&f.pinky)return'open';
  return'none';
}

// ── HAND DRAWING ──
const CONNS=[[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];
const FC=['#ff6b6b','#00f0ff','#39ff14','#ffbe0b','#a855f7'];
const FG=[[0,1,2,3,4],[5,6,7,8],[9,10,11,12],[13,14,15,16],[17,18,19,20]];
const FN=['THB','IDX','MID','RNG','PNK'];const TIPS=[4,8,12,16,20];
function fgi(idx){for(let f=0;f<FG.length;f++)if(FG[f].includes(idx))return f;return 0;}

function drawHand(lm,hi){
  const w=hCv.width,h=hCv.height;
  hCtx.fillStyle=hi===0?'rgba(0,240,255,.04)':'rgba(168,85,247,.04)';
  hCtx.beginPath();[0,5,9,13,17].forEach((id,i)=>{const x=lm[id].x*w,y=lm[id].y*h;i===0?hCtx.moveTo(x,y):hCtx.lineTo(x,y);});
  hCtx.closePath();hCtx.fill();
  for(const[a,b]of CONNS){const fi=fgi(b);hCtx.strokeStyle=FC[fi];hCtx.lineWidth=[0,5,9,13,17].includes(a)?2.5:1.5;hCtx.shadowColor=FC[fi];hCtx.shadowBlur=5;hCtx.globalAlpha=.8;hCtx.beginPath();hCtx.moveTo(lm[a].x*w,lm[a].y*h);hCtx.lineTo(lm[b].x*w,lm[b].y*h);hCtx.stroke();}
  hCtx.globalAlpha=1;hCtx.shadowBlur=0;
  for(let i=0;i<21;i++){const x=lm[i].x*w,y=lm[i].y*h,fi=fgi(i),tip=TIPS.includes(i),r=tip?3.5:2;
    if(tip){hCtx.beginPath();hCtx.arc(x,y,r+4,0,Math.PI*2);hCtx.fillStyle=FC[fi]+'20';hCtx.fill();}
    hCtx.beginPath();hCtx.arc(x,y,r,0,Math.PI*2);hCtx.fillStyle=tip?'#fff':FC[fi];hCtx.fill();}
  for(let f=0;f<5;f++){const t=TIPS[f],x=lm[t].x*w,y=lm[t].y*h;hCtx.font='6px Orbitron';hCtx.fillStyle=FC[f];hCtx.fillText(FN[f],x+6,y-6);}
}

// ── ZIGZAG ERASER DETECTION ──
function checkZigzag(){
  if(fistHistory.length<8)return false;
  const recent=fistHistory.slice(-8);let changes=0;
  for(let i=2;i<recent.length;i++){
    const pd=recent[i-1].x-recent[i-2].x,cd=recent[i].x-recent[i-1].x;
    if(pd*cd<0&&Math.abs(cd)>.005)changes++;
  }
  return changes>=3;
}

// ── TRIPLE TAP DETECTION ──
function checkTripleTap(lm){
  const tipY=lm[8].y;
  // Tap = index tip moves below then above PIP rapidly
  const isPoke=tipY>lm[6].y; // tip below pip = curled
  if(isPoke){tapTimes.push(performance.now());}
  tapTimes=tapTimes.filter(t=>performance.now()-t<1500);
  if(tapTimes.length>=3){tapTimes=[];return true;}
  return false;
}

// ── SMASH DETECTION ──
function checkSmash(){
  if(handCount<2)return false;
  const h1=allHands[0].lm,h2=allHands[1].lm;
  for(const tip of[8,12]){
    for(let i=0;i<21;i++){
      if(d3(h1[tip],h2[i])<0.04)return true;
      if(d3(h2[tip],h1[i])<0.04)return true;
    }
  }
  return false;
}

// ── UI ──
let flashT;
function flash(t){const e=document.getElementById('gesture-flash');e.textContent=t;e.style.opacity='1';clearTimeout(flashT);flashT=setTimeout(()=>e.style.opacity='0',1200);}
function showMode(m){const b=document.getElementById('mode-badge');b.className='glass show '+m;const l={writing:'✏ WRITING',orbit:'🌐 3D ORBIT',particles:'✋ REPEL',dual:'⚡ DUAL',zoom:'🔍 ZOOM',eraser:'🧹 ERASER'};b.textContent=l[m]||m;}
function hideMode(){document.getElementById('mode-badge').classList.remove('show');}

// ── MOUSE FALLBACK ──
let mouse3D=new THREE.Vector3(999,999,999),mouseOn=false;
window.addEventListener('mousemove',e=>{if(handCount>0)return;mouseOn=true;mouse3D.set((e.clientX/innerWidth-.5)*12,-(e.clientY/innerHeight-.5)*10,0);});
window.addEventListener('mouseleave',()=>mouseOn=false);
window.addEventListener('click',e=>{if(handCount>0||e.target.closest('#draw-ctrl')||e.target.closest('#info')||e.target.closest('#guide')||e.target.closest('#guide-toggle')||e.target.closest('#voice-status'))return;nextShape();});
window.addEventListener('wheel',e=>{targetZoom=THREE.MathUtils.clamp(targetZoom+e.deltaY*.005,3,20);});
window.addEventListener('keydown',e=>{
  if(e.key==='p'||e.key==='P')togglePen();
  if(e.key==='c'||e.key==='C')clearDraw();
  if(e.key==='v'||e.key==='V')toggleVoice();
  if(e.key==='g'||e.key==='G')document.getElementById('guide').classList.toggle('open');
});

// ── UPDATE PARTICLES ──
function updateSys(sys,mp,dt,time,repulsor,repOn,repR,repF,exF){
  mp=Math.min(mp+dt/CFG.morphT,1);
  const la=CFG.lerp+mp*.02;
  for(let i=0;i<N;i++){
    const i3=i*3;
    sys.vel[i3]+=(sys.tgt[i3]-sys.pos[i3])*la;
    sys.vel[i3+1]+=(sys.tgt[i3+1]-sys.pos[i3+1])*la;
    sys.vel[i3+2]+=(sys.tgt[i3+2]-sys.pos[i3+2])*la;
    if(exF>0){const ex=sys.pos[i3],ey=sys.pos[i3+1],ez=sys.pos[i3+2],ed=Math.sqrt(ex*ex+ey*ey+ez*ez)+.01;sys.vel[i3]+=ex/ed*exF;sys.vel[i3+1]+=ey/ed*exF;sys.vel[i3+2]+=ez/ed*exF;}
    if(repOn){const rx=sys.pos[i3]-repulsor.x,ry=sys.pos[i3+1]-repulsor.y,rz=sys.pos[i3+2]-repulsor.z,rd=Math.sqrt(rx*rx+ry*ry+rz*rz)+.001;
      if(rd<repR){const f=(1-rd/repR)*repF;sys.vel[i3]+=rx/rd*f;sys.vel[i3+1]+=ry/rd*f;sys.vel[i3+2]+=rz/rd*f;}}
    sys.vel[i3]*=CFG.friction;sys.vel[i3+1]*=CFG.friction;sys.vel[i3+2]*=CFG.friction;
    sys.pos[i3]+=sys.vel[i3];sys.pos[i3+1]+=sys.vel[i3+1];sys.pos[i3+2]+=sys.vel[i3+2];
    sys.pos[i3+1]+=Math.sin(time*1.5+i*.01)*.003;
    const spd=Math.abs(sys.vel[i3])+Math.abs(sys.vel[i3+1])+Math.abs(sys.vel[i3+2]);
    sys.al[i]=THREE.MathUtils.clamp(.5+spd*8,.4,1);sys.sz[i]=THREE.MathUtils.clamp(1.5+spd*20,1.5,5);
  }
  sys.pA.needsUpdate=true;sys.sA.needsUpdate=true;sys.aA.needsUpdate=true;
  return mp;
}

// ── MAIN LOOP ──
let time=0,frames=0,fpsT=0;const clock=new THREE.Clock();

function animate(){
  requestAnimationFrame(animate);
  const dt=Math.min(clock.getDelta(),.05);time+=dt;const now=performance.now()/1000;
  frames++;fpsT+=dt;if(fpsT>=.5){document.getElementById('fps').textContent=Math.round(frames/fpsT)+' FPS';frames=0;fpsT=0;}
  if(fistDb>0)fistDb-=dt;if(shapeDb>0)shapeDb-=dt;if(smashDb>0)smashDb-=dt;

  let repulsor=mouse3D.clone(),repOn=mouseOn,repR=CFG.repR,repF=CFG.repF;
  let statusText='NO HAND',statusColor='#ffffff40',modeType='';
  explodeForce=0;

  if(handCount===0){
    if(drawing){drawing=false;lastPt=null;pointBuf=[];pfX.r();pfY.r();}
    hideMode();prevPinchD=null;prevDualPinchD=null;prev2FingerD=null;fistHistory=[];
    ['thumb','index','middle','ring','pinky'].forEach(n=>{const r=document.getElementById('fi-'+n);r.classList.remove('active');r.querySelector('.fi-state').textContent='—';});
  }
  else if(handCount===1){
    const H=allHands[0],lm=H.lm,g=H.g,palm=lm[9];
    repulsor.set((.5-palm.x)*14,-(palm.y-.5)*10,-(palm.z)*5);

    if(g==='twoFinger'){
      // ZOOM: measure spread between index & middle tips (delta-based)
      const curD=d3(lm[8],lm[12]);
      if(prev2FingerD!==null){
        const delta=curD-prev2FingerD;
        targetZoom=THREE.MathUtils.clamp(targetZoom-delta*CFG.zoomSens,3,20);
      }
      prev2FingerD=curD;
      statusText='🔍 ZOOM';statusColor='#ffbe0b';modeType='zoom';
      if(drawing){drawing=false;lastPt=null;pointBuf=[];pfX.r();pfY.r();}
      prevPinchD=null;lastOrbitX=null;lastOrbitY=null;
    }
    else if(g==='index'&&penOn){
      statusText='✏ WRITING';statusColor='#ff2d95';modeType=eraserOn?'eraser':'writing';
      const tip=lm[8],rawX=(1-tip.x)*dCv.width,rawY=tip.y*dCv.height;
      const sx=pfX.f(rawX,now),sy=pfY.f(rawY,now);
      if(!drawing){drawing=true;lastPt={x:sx,y:sy};pointBuf=[{x:sx,y:sy}];}
      else{const dd=Math.hypot(sx-lastPt.x,sy-lastPt.y);if(dd>1.5&&dd<150)addDrawPoint(sx,sy);lastPt={x:sx,y:sy};}
      prev2FingerD=null;prevPinchD=null;
    }
    else if(g==='open'){
      statusText='✋ REPEL';statusColor='#00f0ff';modeType='particles';
      repOn=true;stopDraw();prev2FingerD=null;prevPinchD=null;lastOrbitX=null;
    }
    else if(g==='pinch'){
      const curPD=d3(lm[4],lm[8]);
      if(prevPinchD!==null){const delta=curPD-prevPinchD;targetZoom=THREE.MathUtils.clamp(targetZoom-delta*CFG.zoomSens,3,20);}
      prevPinchD=curPD;
      statusText='🤏 FINE ZOOM';statusColor='#a855f7';modeType='zoom';
      stopDraw();prev2FingerD=null;
    }
    else if(g==='fist'){
      statusText='✊ FIST';statusColor='#ffbe0b';
      fistHistory.push({x:lm[0].x,t:now});fistHistory=fistHistory.filter(f=>now-f.t<1);
      if(checkZigzag()&&penOn){eraserOn=!eraserOn;flash(eraserOn?'ERASER ON':'ERASER OFF');fistHistory=[];}
      else if(prevGesture!=='fist'&&fistDb<=0){
        if(autoOn){stopAuto();flash('AUTO STOPPED');}
        fistDb=1.5;
      }
      stopDraw();prev2FingerD=null;prevPinchD=null;
    }
    else{statusText='TRACKING';statusColor='#ffffff50';stopDraw();prev2FingerD=null;prevPinchD=null;lastOrbitX=null;}
    prevGesture=g;prevDualPinchD=null;
  }
  else if(handCount===2){
    const H1=allHands[0],H2=allHands[1];
    const g1=H1.g,g2=H2.g;
    stopDraw();prev2FingerD=null;prevPinchD=null;

    // Smash detection (pen toggle)
    if(checkSmash()&&smashDb<=0){togglePen();smashDb=2;}

    // Determine which hand is doing what
    // One open + other twoFinger = 3D ORBIT
    if((g1==='open'&&g2==='twoFinger')||(g1==='twoFinger'&&g2==='open')){
      const orbiter=g1==='twoFinger'?H1:H2;
      const midX=(orbiter.lm[8].x+orbiter.lm[12].x)/2,midY=(orbiter.lm[8].y+orbiter.lm[12].y)/2;
      if(lastOrbitX!==null){
        orbitTheta+=(midX-lastOrbitX)*6;
        orbitPhi=THREE.MathUtils.clamp(orbitPhi+(midY-lastOrbitY)*4,-1.4,1.4);
      }
      lastOrbitX=midX;lastOrbitY=midY;
      statusText='🌐 3D ORBIT';statusColor='#39ff14';modeType='orbit';
      prevDualPinchD=null;
    }
    // One open + other index = triple tap check (spawn shape2)
    else if((g1==='open'&&g2==='index')||(g1==='index'&&g2==='open')){
      const tapper=g1==='index'?H1:H2;
      if(checkTripleTap(tapper.lm)){spawnShape2();}
      statusText='👆 TAP TO SPAWN';statusColor='#a855f7';
      lastOrbitX=null;prevDualPinchD=null;
    }
    // Both open = explode
    else if(g1==='open'&&g2==='open'){
      const p1=H1.lm[9],p2=H2.lm[9],hd=d3(p1,p2);
      explodeForce=THREE.MathUtils.mapLinear(hd,0.1,0.8,0,0.3);
      repulsor.set((.5-(p1.x+p2.x)/2)*14,-((p1.y+p2.y)/2-.5)*10,0);
      repOn=true;repF=.3;repR=6;
      statusText='💥 EXPLODE';statusColor='#ff2d95';modeType='dual';
      lastOrbitX=null;prevDualPinchD=null;
    }
    // Fist + open = next shape
    else if((g1==='fist'&&g2==='open')||(g1==='open'&&g2==='fist')){
      if(shapeDb<=0){nextShape();shapeDb=2;}
      statusText='⏭ NEXT SHAPE';statusColor='#39ff14';modeType='dual';
      lastOrbitX=null;prevDualPinchD=null;
    }
    // Both pinch = fine zoom
    else if(g1==='pinch'&&g2==='pinch'){
      const dd=d3(H1.lm[4],H2.lm[4]);
      if(prevDualPinchD!==null){targetZoom=THREE.MathUtils.clamp(targetZoom-(dd-prevDualPinchD)*CFG.zoomSens*.8,3,20);}
      prevDualPinchD=dd;
      statusText='🔍 DUAL ZOOM';statusColor='#a855f7';modeType='zoom';
      lastOrbitX=null;
    }
    else{statusText=g1+' + '+g2;statusColor='#ffffff50';lastOrbitX=null;prevDualPinchD=null;}

    // Activation: check raised hands
    const lRaised=allHands.some(h=>h.lb==='Left'&&h.g==='open'&&h.lm[0].y<0.4);
    const rRaised=allHands.some(h=>h.lb==='Right'&&h.g==='open'&&h.lm[0].y<0.4);
    if(lRaised&&rRaised)activeTarget='both';
    else if(rRaised)activeTarget='both';
    else if(lRaised)activeTarget='shape1';
    else activeTarget=shape2Active?'both':'shape1';
  }

  document.getElementById('gesture-status').textContent=statusText;
  document.getElementById('gesture-status').style.color=statusColor;
  document.getElementById('active-target').textContent=shape2Active?'TARGET: '+(activeTarget==='both'?'BOTH SHAPES':'SHAPE 1'):'';
  if(modeType)showMode(modeType);else if(handCount>0)hideMode();

  // ── CAMERA (spherical coords for true 3D orbit) ──
  autoRotateAngle+=dt*0.07;
  const camTheta=orbitTheta+autoRotateAngle;
  targetZoom=THREE.MathUtils.clamp(targetZoom,3,20);
  orbitR+=(targetZoom-orbitR)*.04;
  camera.position.x=orbitR*Math.sin(camTheta)*Math.cos(orbitPhi);
  camera.position.y=orbitR*Math.sin(orbitPhi);
  camera.position.z=orbitR*Math.cos(camTheta)*Math.cos(orbitPhi);
  camera.lookAt(0,0,0);

  // ── UPDATE PARTICLES ──
  morphProg=updateSys(S1,morphProg,dt,time,repulsor,repOn,repR,repF,explodeForce);
  S1.pts.rotation.y=time*.03;
  if(shape2Active){
    const rep2=repulsor.clone();rep2.x-=5; // offset for shape2 position
    morph2Prog=updateSys(S2,morph2Prog,dt,time,rep2,repOn,repR,repF,explodeForce);
    S2.pts.rotation.y=-time*.025;
  }
  ren.render(scene,camera);
}

function stopDraw(){if(drawing){drawing=false;lastPt=null;pointBuf=[];pfX.r();pfY.r();}}

// ── RESIZE ──
window.addEventListener('resize',()=>{
  camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();
  ren.setSize(innerWidth,innerHeight);
  const img=dCtx.getImageData(0,0,dCv.width,dCv.height);
  dCv.width=innerWidth;dCv.height=innerHeight;dCtx.putImageData(img,0,0);
});

// ── INIT ──
initVoice();initCamera();
setTimeout(()=>document.getElementById('loading').classList.add('hide'),8000);
animate();
