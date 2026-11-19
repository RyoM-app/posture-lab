import {rad,deg,clamp,median,sd,mean,faceRotation,headInclination,headInclinationFromUp,measureIris,upFromOrientation,upFromGravity,IRIS_POINTS} from './geometry.js';
import {READING_VERSION,READING_PAGES,READING_TEXTS_VERSION,chooseReadingText} from './reading.js';
import './protocol.js';   // 進行表（CVAカメラと同じファイル）。window.POSTURE_PROTOCOL
import {ToneDetector} from './tone-detect.js';
const PP=window.POSTURE_PROTOCOL;
// 0.4.0：開始の合図。音の合図＝CVAカメラの開始の音をマイクで聞く。手動＝待機画面を2秒長押し → 10秒のカウントダウン → 0 で開始
const SYNC={countdownSec:10,toneSamples:2048};

const $=id=>document.getElementById(id), video=$('video'),canvas=$('overlay'),ctx=canvas.getContext('2d');
const MP_VERSION='1.0.1';
const APP_VERSION='0.4.0';
const MODEL='https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const BASE=`https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
const n=x=>typeof x==='number'&&Number.isFinite(x)?x:null;
const fmt=(x,d=1)=>n(x)==null?'—':x.toFixed(d);
const signed=x=>n(x)==null?'—':`${x>=0?'+':''}${x.toFixed(1)}°`;
const screenAngle=()=>screen.orientation?.angle ?? window.orientation ?? 0;
const portrait=()=>Math.abs(screenAngle()%180)<1;
const state={running:false,starting:false,stream:null,worker:null,detector:null,mode:null,generation:0,
  orientation:null,motion:null,baseline:null,calibration:null,collect:null,latest:null,pending:null,
  nextId:0,lastFrame:0,lastVideoTime:-1,frames:[],session:null,recording:false,dirty:false,wake:null,
  imageSize:null,timer:null,storageOK:true,saveBusy:false,saveTask:null,recordStarting:false,awaitingNext:false,archives:new Map(),lastCheckpoint:0,saved:{frames:0,motion:0,orientation:0,events:0},chunk:1};

// ---- 終了時の品質判定（本実験の「事前に決める除外基準」の代わり。区間を知らないので5秒窓で見る）
// 0.2.1：h の割合と途切れは「顔が写っているのに h が出ない」フレームだけで判定する（顔が写っていない時間は別に表示）。
//        スタンドの動きは記録開始時の1秒間の上向きと比べ、2°を超えたら。基準が5分以上前なら取り直すよう表示する
const QUALITY={windowSec:5,windowStepSec:.5,minWindowRate:.7,maxHGapSec:2,imuGapMs:250,standMoveDeg:2,standReturnDeg:1,standRefMs:1000,
  baselineMaxAgeSec:300,noFaceMinSec:.5,touchNearMs:300,stopHoldMs:2000};   // 0.3.0：停止の長押しは2秒
// 0.3.0：記録中の計測画面に表示する文章のページ送り（秒）。CVAカメラの「読書」区間（120秒）用だが、区間は分からないので記録中ずっと表示する
const READING={pageSec:18};
const IRIS_OCCLUDED_OPEN=.15;   // eyeOpenMin がこれ未満なら、まぶたが虹彩を隠している（zFocalCm が大きく出る）として irisOccluded = true
// IMU：方向（deviceorientation）が古いときは、加速度（devicemotion）の重力成分から上向きを求める予備の経路を使う
const IMU={maxAgeMs:250,gravityLowPass:.2};   // 重力成分は指数平滑（60 Hzで約80 ms）して手の動きを抑える
const dot3=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];

// ---- セットアップとカメラ校正（0.2.0）
// 0.3.1：厳しすぎて3つを同時に満たせなかったため緩めた（0.2.x は ±1°・±1 cm・±1 cm）。高さと距離は被験者の呼吸や頭の小さな動きでも変わり、
// 虹彩の実寸の仮定（11.7 mm）だけで距離に ±2 cm 程度の誤差があるので、±1 cm は測れる精度より細かかった。
// 表示は直近 smoothMs の中央値。一度緑になった項目は、許容の releaseFactor 倍を超えるまで緑のまま（ちらつき防止）。
// セットアップは目安で、合格しなくても基準は記録できる（実際の値は meta.setup に残る）
const SETUP={irisMm:11.7,tiltTolDeg:2,heightTolCm:2,distanceTolCm:3,releaseFactor:1.5,smoothMs:1000,stableMs:1000};
const CAMERA_CALIB_KEY='posture-lab.cameraCalibration.v1';
let audio=null;
function beep(freq=880,ms=120,gain=.25){try{audio??=new (window.AudioContext||window.webkitAudioContext)();const o=audio.createOscillator(),g=audio.createGain();o.frequency.value=freq;o.connect(g);g.connect(audio.destination);g.gain.setValueAtTime(gain,audio.currentTime);g.gain.exponentialRampToValueAtTime(.001,audio.currentTime+ms/1000);o.start();o.stop(audio.currentTime+ms/1000);}catch{/* 音は任意 */}}
let camCalCache;   // localStorage を毎フレーム読まないよう覚えておく（保存・消去のときに捨てる）
function loadCameraCalibration(){if(camCalCache===undefined){try{const c=JSON.parse(localStorage.getItem(CAMERA_CALIB_KEY));camCalCache=c&&c.focalPx>0?c:null;}catch{camCalCache=null;}}return camCalCache;}
// いま使う焦点距離。校正が同じ解像度ならそれを使い、なければ仮の画角から求める
function focal(){
  const w=canvas.width,h=canvas.height,c=loadCameraCalibration();
  if(c&&c.width===w&&c.height===h)return {f:c.focalPx,source:'charuco',calibration:c};
  return {f:w/(2*Math.tan(rad(Number($('hfov').value)||60)/2)),source:'assumed-hfov',calibration:c,mismatch:!!c};
}
// 端末の傾き：端末座標で表した鉛直上向き u から。縦向きで垂直に立てると u = (0, 1, 0)
//   左右 = atan2(u_x, u_y)（＋：上端が左に傾く、画面を見て）、前後 = atan2(u_z, u_y)（＋：画面が上を向く＝上端が奥へ倒れる）
function deviceTilt(up){if(!up)return null;return {lr:deg(Math.atan2(up[0],up[1])),fb:deg(Math.atan2(up[2],up[1]))};}
// ---- 被験者・条件・回（前回の値を覚える）
const SUBJECT_KEY='posture-lab.subject.v1',HOLD_FOR={fixed:'stand',hand:'hand'},KIND_FOR={fixed:'stand',hand:'dual'};
function subjectForm(){return {id:$('subjId').value.trim().toUpperCase(),condition:$('condition').value,run:Number($('runNo').value)||null,memo:$('memo').value.trim()};}
function checkSubject(f){if(!/^P\d{2}$/.test(f.id))return '被験者IDを P01 の形（Pと数字2桁）で入力してください。';if(!(f.run>=1))return '回番号を1以上で入力してください。';return null;}
function restoreSubject(){try{const f=JSON.parse(localStorage.getItem(SUBJECT_KEY));if(f){$('subjId').value=f.id||'';$('condition').value=f.condition||'fixed';$('runNo').value=f.run||1;$('memo').value=f.memo||'';}}catch{}}
function applyCondition(){const m=HOLD_FOR[$('condition').value];if(m)$('holdMode').value=m;const k=KIND_FOR[$('condition').value];if(k)$('protocolKind').value=k;updateRecordButton();}
function updateRecordButton(){$('record').textContent=$('protocolKind').value==='none'?'記録開始':'合図待ちにする';}
function status(message,error=false){$('status').textContent=message;$('status').classList.toggle('error',error);}
function event(type,detail={}){if(state.recording)state.session.events.push({t:performance.now(),type,...detail});}
function config(){return {hfov:Number($('hfov').value),irisMm:Number($('irisMm').value),...modelConfig()};}
// Filled after the user agrees to a specific provisional-CVA model.
function modelConfig(){return {cvaModel:'pending',cvaBaselineDeg:null};}
function provisionalCva(delta){return null;}

function permissionsFromClick(){
  // Invoke both methods synchronously within the button gesture, before any await.
  const requests=[['motion',window.DeviceMotionEvent],['orientation',window.DeviceOrientationEvent]].map(([kind,api])=>{
    try{return Promise.resolve(typeof api?.requestPermission==='function'?api.requestPermission():(api?'not-required':'unavailable')).then(value=>({kind,value}));}
    catch(e){return Promise.resolve({kind,value:'error',message:e.message});}
  });
  return Promise.allSettled(requests).then(results=>{
    const values=results.map(r=>r.status==='fulfilled'?r.value:{value:'denied'});
    $('imuStatus').textContent=values.some(v=>['denied','error','unavailable'].includes(v.value))?'IMU：一部未許可／未対応':'IMU：受信待ち';
    event('permission',{values});return values;
  });
}

window.addEventListener('deviceorientation',e=>{
  if(!state.running&&!state.starting)return;
  const o={t:performance.now(),eventTimestamp:e.timeStamp,alpha:n(e.alpha),beta:n(e.beta),gamma:n(e.gamma),absolute:!!e.absolute};
  state.orientation=o;
  if(state.recording)state.session.orientation.push(o);
});
window.addEventListener('devicemotion',e=>{
  if(!state.running&&!state.starting)return;
  const vector=v=>({x:n(v?.x),y:n(v?.y),z:n(v?.z)});
  const m={t:performance.now(),eventTimestamp:e.timeStamp,interval:n(e.interval),acceleration:vector(e.acceleration),includingGravity:vector(e.accelerationIncludingGravity),rotationRate:{alpha:n(e.rotationRate?.alpha),beta:n(e.rotationRate?.beta),gamma:n(e.rotationRate?.gamma)}};
  const g=m.includingGravity;
  if([g.x,g.y,g.z].every(Number.isFinite)&&(g.x||g.y||g.z)){
    const a=IMU.gravityLowPass,lp=state.gravLP;
    state.gravLP=lp?{x:lp.x+a*(g.x-lp.x),y:lp.y+a*(g.y-lp.y),z:lp.z+a*(g.z-lp.z)}:{...g};
    m.gravityLP={...state.gravLP};
  }
  state.motion=m;
  if(state.recording)state.session.motion.push(m);
});

async function mainDetector(){
  const {FaceLandmarker,FilesetResolver}=await import(`${BASE}/vision_bundle.mjs`);
  const files=await FilesetResolver.forVisionTasks(`${BASE}/wasm`);
  const options=delegate=>({baseOptions:{modelAssetPath:MODEL,delegate},runningMode:'VIDEO',numFaces:1,outputFacialTransformationMatrixes:true});
  try {state.detector=await FaceLandmarker.createFromOptions(files,options('GPU'));state.mode='main/GPU';}
  catch {state.detector=await FaceLandmarker.createFromOptions(files,options('CPU'));state.mode='main/CPU';}
}
async function createDetector(){
  try{
    if(typeof Worker==='undefined'||typeof createImageBitmap==='undefined')throw Error('Worker未対応');
    const w=new Worker(new URL('./vision-worker.js',import.meta.url),{type:'module'});state.worker=w;
    await new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(Error('モデルの読み込みがタイムアウトしました')),45000);
      const fail=e=>{clearTimeout(timeout);reject(Error(e.message||'Workerを起動できません'));};
      w.onerror=fail;
      w.onmessage=({data})=>{
        if(data.type==='ready'){clearTimeout(timeout);state.mode=`worker/${data.delegate}`;resolve();}
        else if(data.type==='error')fail(data);
      };
      w.postMessage({type:'init'});
    });
    w.onmessage=({data})=>{
      const pending=state.pending;
      if(!pending||data.id!==pending.id)return;
      clearTimeout(state.timer);state.pending=null;
      if(data.type==='result')consume(data,pending);
      else {status(`顔推定でエラー：${data.message}`,true);event('inference_error',{message:data.message});}
    };
    w.onerror=e=>{status(`顔推定が停止しました。終了後に再度開始してください：${e.message}`,true);stop();};
  }catch(e){
    state.worker?.terminate();state.worker=null;
    status('互換モードで顔推定を準備しています。処理速度が低下する場合があります。');
    await mainDetector();
  }
}
async function wake(){try{if(!state.wake||state.wake.released)state.wake=await navigator.wakeLock?.request('screen');}catch{/* Optional feature. */}}

$('start').addEventListener('click',async()=>{
  if(state.running||state.starting)return;
  beep(440,1,.001);   // iOSで音を鳴らせるよう、ボタン操作の中で初期化
  if(!window.isSecureContext||!navigator.mediaDevices?.getUserMedia){status('HTTPSのURLから開いてください。PCではlocalhostも使えます。',true);return;}
  const permission=permissionsFromClick();
  state.starting=true;$('start').disabled=true;status('センサーの許可を確認しています…');
  try{
    await permission;
    state.stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:'user'},width:{ideal:1280},height:{ideal:720},frameRate:{ideal:30,max:30}}});
    video.srcObject=state.stream;await video.play();
    const track=state.stream.getVideoTracks()[0];
    state.cameraSettings=track.getSettings();
    if(state.cameraSettings.facingMode==='environment')throw Error('背面カメラが選択されました。前面カメラが使えるブラウザで開いてください。');
    state.imageSize=[video.videoWidth,video.videoHeight];
    canvas.width=video.videoWidth;canvas.height=video.videoHeight;
    $('previewHint').style.display='none';$('cameraStatus').textContent=`カメラ：${video.videoWidth}×${video.videoHeight}`;
    status('顔推定モデルを準備しています…初回は通信が必要です。');
    await createDetector();
    state.running=true;state.generation++;state.baseline=null;state.calibration=null;state.lastVideoTime=-1;state.lastFrame=0;
    $('modelStatus').textContent=`顔推定：${state.mode}`;
    $('diagnostics').textContent=JSON.stringify({app:`posture-lab/${APP_VERSION}`,mediapipe:MP_VERSION,model:MODEL,browser:navigator.userAgent,settings:state.cameraSettings,supportedConstraints:navigator.mediaDevices.getSupportedConstraints(),screenAngle:screenAngle(),inference:state.mode},null,2);
    $('stop').disabled=false;$('retryImu').disabled=false;$('calibStart').disabled=false;refreshCalibStatus();
    status('準備できました。縦持ちで顔を正面に向け、基準姿勢を記録してください。');
    track.addEventListener('ended',()=>{if(state.running){stop();status('カメラが切断されました。再度開始してください。',true);}});
    await wake();requestAnimationFrame(tick);
  }catch(e){stop();status(`開始できませんでした：${e.message}。カメラ許可・通信・HTTPS接続を確認してください。`,true);}
  finally{state.starting=false;$('start').disabled=state.running;}
});
$('retryImu').addEventListener('click',()=>{permissionsFromClick();});
$('stop').addEventListener('click',stop);
function stop(){
  dismissNextRecord();endCalibration();$('calibStart').disabled=true;
  if(state.recording)endRecord('camera_stopped');
  state.running=false;state.generation++;state.pending=null;state.collect=null;state.latest=null;
  clearTimeout(state.timer);state.worker?.terminate();state.worker=null;state.detector?.close();state.detector=null;
  state.stream?.getTracks().forEach(t=>t.stop());state.stream=null;video.srcObject=null;
  state.wake?.release().catch(()=>{});state.wake=null;
  state.orientation=null;state.motion=null;state.baseline=null;state.calibration=null;
  for(const id of ['stop','baseline','calibrate','clearCalibration','record','retryImu'])$(id).disabled=true;
  $('start').disabled=false;$('previewHint').style.display='grid';$('cameraStatus').textContent='カメラ：停止';$('imuStatus').textContent='IMU：停止';$('modelStatus').textContent='顔推定：停止';
  $('baselineStatus').textContent='基準姿勢：未設定';$('calibrationStatus').textContent='距離校正：未設定';
  clearValues();status('終了しました。記録がある場合は保存してください。');
}

function tick(t){
  if(!state.running)return;
  requestAnimationFrame(tick);
  if(state.calib)return;   // カメラ校正中は顔推定を止める
  const period=state.mode.startsWith('worker')?67:125;
  if(document.hidden||state.pending||video.readyState<2||t-state.lastFrame<period||video.currentTime===state.lastVideoTime)return;
  if(video.videoWidth!==state.imageSize[0]||video.videoHeight!==state.imageSize[1]){
    invalidate('映像の解像度が変わりました。基準姿勢・距離校正を取り直してください。');
    state.calibration=null;state.imageSize=[video.videoWidth,video.videoHeight];canvas.width=video.videoWidth;canvas.height=video.videoHeight;
  }
  state.lastFrame=t;state.lastVideoTime=video.currentTime;
  const p={id:++state.nextId,t:performance.now(),videoTime:video.currentTime,o:state.orientation?{...state.orientation}:null,m:state.motion,angle:screenAngle(),generation:state.generation};
  state.pending=p;
  if(state.worker){
    createImageBitmap(video).then(image=>{
      if(!state.running||p.generation!==state.generation){image.close();return;}
      state.timer=setTimeout(()=>{stop();status('顔推定から応答がありません。再度開始してください。',true);},12000);
      state.worker.postMessage({type:'frame',id:p.id,t:p.t,image},[image]);
    }).catch(async e=>{
      state.worker?.terminate();state.worker=null;status('映像転送に対応していないため互換モードへ切り替えます。');
      try{await mainDetector();if(state.running&&p.generation===state.generation){state.pending=null;$('modelStatus').textContent=`顔推定：${state.mode}`;}else{state.detector?.close();state.detector=null;}}
      catch(error){stop();status(`顔推定を開始できません：${error.message}`,true);}
    });
  }else{
    try{const begin=performance.now(),r=state.detector.detectForVideo(video,p.t);state.pending=null;consume({landmarks:r.faceLandmarks[0],matrix:r.facialTransformationMatrixes[0],inferenceMs:performance.now()-begin},p);}
    catch(e){state.pending=null;stop();status(`顔推定を続行できません：${e.message}`,true);}
  }
}

function consume(result,p){
  if(!state.running||p.generation!==state.generation||document.hidden)return;
  const now=performance.now(),pose=faceRotation(result.matrix),iris=measureIris(result.landmarks,canvas.width,canvas.height);
  const age=p.o?p.t-p.o.t:null;
  const fresh=age!==null&&age>=0&&age<=250&&p.o.beta!==null&&p.o.gamma!==null;
  const portraitFrame=Math.abs(p.angle%180)<1;
  const faceValid=!!pose&&Math.abs(pose.yaw)<=25&&Math.abs(pose.pitch)<=40&&Math.abs(pose.roll)<=25&&portraitFrame;
  const irisValid=faceValid&&!!iris?.valid;
  const head=faceValid&&fresh?headInclination(pose,p.o):null;
  const cfg=config(),f=canvas.width/(2*Math.tan(rad(cfg.hfov)/2));
  const z=irisValid?(state.calibration?state.calibration.k/iris.p:f*cfg.irisMm/iris.p/10):null;
  const ratio=irisValid&&state.baseline?state.baseline.irisPx/iris.p*100:null;
  const delta=head!==null&&state.baseline?.head!==null&&state.baseline?.head!==undefined?head-state.baseline.head:null;
  // f を使った値（0.2.0）：Z = f × 11.7 mm ÷ 虹彩径、目の中点の主点（画像の中心）からのずれ（cm）＝ 画素 × Z / f
  // IMU の2つの経路（0.2.0）：方向から求めた上向き upO、加速度の重力成分から求めた上向き upM
  const mAge=p.m?p.t-p.m.t:null,mFresh=mAge!==null&&mAge>=0&&mAge<=IMU.maxAgeMs&&!!p.m.gravityLP;
  const upO=fresh?upFromOrientation(p.o):null;
  if(upO&&mFresh){const g=p.m.gravityLP,nm=Math.hypot(g.x,g.y,g.z);state.gravSign=dot3([g.x/nm,g.y/nm,g.z/nm],upO)>=0?1:-1;state.gravSignSource='orientation';}
  else if(mFresh&&state.gravSign===undefined){state.gravSign=p.m.gravityLP.y<0?-1:1;state.gravSignSource='portrait-assumption';}   // 縦向き・上が上の前提
  const upM=mFresh?upFromGravity(p.m.gravityLP,state.gravSign??1):null;
  const up=upO??upM,imuSource=upO?'orientation':upM?'motion':null;
  // h は有効範囲外の顔の向きでも計算して残す（既存の headInclination は変えない）
  const hO=pose&&portraitFrame&&upO?headInclinationFromUp(pose,upO):null,hM=pose&&portraitFrame&&upM?headInclinationFromUp(pose,upM):null,hRaw=hO??hM;
  // 固定（スタンド）では端末が動かないので、基準時の上向きで h を補う（IMU が途切れても出る）
  const stand=(state.recording?state.session.meta.holdMode:$('holdMode').value)==='stand',bUp=state.baseline?.up??null;
  const hFixed=stand&&bUp&&pose&&portraitFrame?headInclinationFromUp(pose,bUp):null;
  const standChange=stand&&bUp&&up?deg(Math.acos(clamp(dot3(up,bUp),-1,1))):null;
  // 記録開始時の1秒間の上向きの平均と比べる（0.2.1。スタンドの動きの判定はこちら）
  const sw=state.recording?state.standWatch:null;
  if(sw&&stand&&up&&!sw.ref){if(p.t-state.session.meta.start<QUALITY.standRefMs){sw.acc[0]+=up[0];sw.acc[1]+=up[1];sw.acc[2]+=up[2];sw.n++;}
    else if(sw.n){const m=Math.hypot(...sw.acc);sw.ref=sw.acc.map(x=>x/m);state.session.meta.standReference={up:sw.ref,frames:sw.n,windowMs:QUALITY.standRefMs};}}
  const standFromStart=sw?.ref&&up?deg(Math.acos(clamp(dot3(up,sw.ref),-1,1))):null;
  const reasons=[];
  if(!pose)reasons.push('no_face');
  else{if(Math.abs(pose.yaw)>25)reasons.push('yaw');if(Math.abs(pose.pitch)>40)reasons.push('pitch');if(Math.abs(pose.roll)>25)reasons.push('roll');}
  if(!portraitFrame)reasons.push('landscape');
  if(pose)reasons.push(...(iris?iris.reasons:['no_iris']));
  if(!fresh)reasons.push(p.o?'orientation_stale':'orientation_missing');
  if(!mFresh)reasons.push(p.m?'motion_stale':'motion_missing');
  const fc=focal(),tilt=deviceTilt(up);
  const zf=iris&&iris.p>0?fc.f*SETUP.irisMm/iris.p/10:null;
  const ex=iris?iris.center[0]*canvas.width-canvas.width/2:null,ey=iris?iris.center[1]*canvas.height-canvas.height/2:null;
  const row={t:p.t,processedAt:now,videoTime:p.videoTime,inferenceMs:result.inferenceMs,deliveryMs:now-p.t,
    width:canvas.width,height:canvas.height,screenAngle:p.angle,faceDetected:!!pose,faceValid,irisValid,imuValid:fresh&&portraitFrame,
    orientationReceivedAt:p.o?.t??null,orientationEventTimestamp:p.o?.eventTimestamp??null,imuAgeMs:age,
    alpha:p.o?.alpha??null,beta:p.o?.beta??null,gamma:p.o?.gamma??null,
    motionReceivedAt:p.m?.t??null,ax:p.m?.acceleration.x??null,ay:p.m?.acceleration.y??null,az:p.m?.acceleration.z??null,
    gx:p.m?.includingGravity.x??null,gy:p.m?.includingGravity.y??null,gz:p.m?.includingGravity.z??null,
    rotationAlpha:p.m?.rotationRate.alpha??null,rotationBeta:p.m?.rotationRate.beta??null,rotationGamma:p.m?.rotationRate.gamma??null,
    pitch:pose?.pitch??null,yaw:pose?.yaw??null,roll:pose?.roll??null,headInclination:head,headDelta:delta,
    provisionalCva:provisionalCva(delta),irisPx:iris?.p??null,irisLeftPx:iris?.left??null,irisRightPx:iris?.right??null,
    eyeX:iris?.center[0]??null,eyeY:iris?.center[1]??null,distanceCm:z,distanceRatioPercent:ratio,
    distanceMode:state.calibration?'one-point-calibrated':'assumed-fov',...cfg,
    focalPx:fc.f,focalSource:fc.source,zFocalCm:zf,eyeOffsetXPx:ex,eyeOffsetYPx:ey,
    eyeOffsetXCm:zf!==null?ex*zf/fc.f:null,eyeOffsetYCm:zf!==null?ey*zf/fc.f:null,
    deviceTiltLRDeg:tilt?.lr??null,deviceTiltFBDeg:tilt?.fb??null,
    headInclinationRaw:hRaw,headInclinationOrientation:hO,headInclinationMotion:hM,headInclinationFixedUp:hFixed,
    imuSource,motionAgeMs:mAge,gravitySign:state.gravSign??null,gravitySignSource:state.gravSignSource??null,
    gravityLPx:p.m?.gravityLP?.x??null,gravityLPy:p.m?.gravityLP?.y??null,gravityLPz:p.m?.gravityLP?.z??null,
    upX:up?.[0]??null,upY:up?.[1]??null,upZ:up?.[2]??null,standTiltChangeDeg:standChange,standTiltChangeFromStartDeg:standFromStart,invalidReasons:reasons.join('|'),
    irisRightHPx:iris?.rightHV.h??null,irisRightVPx:iris?.rightHV.v??null,irisLeftHPx:iris?.leftHV.h??null,irisLeftVPx:iris?.leftHV.v??null,
    eyeOpenRight:iris?.openRight??null,eyeOpenLeft:iris?.openLeft??null,eyeOpenMin:iris?.open??null,irisOccluded:n(iris?.open)!==null?iris.open<IRIS_OCCLUDED_OPEN:null,
    eyelidGapRightPx:iris?.eyelidGapPx.right??null,eyelidGapLeftPx:iris?.eyelidGapPx.left??null,
    ...Object.fromEntries(IRIS_POINTS.flatMap(i=>[[`iris${i}X`,iris?.points[i][0]??null],[`iris${i}Y`,iris?.points[i][1]??null]])),
    matrix:pose?.matrix??null,matrixColumnMajor:pose?.columnMajor??null};
  if(sw&&standFromStart!==null){   // 固定の記録中に端末の傾きが記録開始時から2°を超えたらイベントにする
    if(standFromStart>sw.max){sw.max=standFromStart;sw.maxAtSec=(p.t-state.session.meta.start)/1000;}
    if(!sw.moved&&standFromStart>QUALITY.standMoveDeg){sw.moved=true;sw.count++;event('stand_moved',{angleDeg:standFromStart,source:imuSource,reference:'record_start'});}
    else if(sw.moved&&standFromStart<QUALITY.standReturnDeg){sw.moved=false;event('stand_returned',{angleDeg:standFromStart,source:imuSource,reference:'record_start'});}
  }
  // 0.4.0：進行表の区間（自分の時計で、開始の合図からの秒で決める。正式な区間は解析で CVAカメラ側と合わせる）
  const tt=state.recording?state.timetable:null;
  if(tt){const sec=(p.t-tt.t0)/1000,at=PP.segmentAt(tt.sch,sec);row.protocolSec=sec;row.label=at.seg?.label??(at.phase==='lead'?'準備':'終了');
    row.stage=at.seg?(at.seg.nod?'nod':at.phase):(at.phase==='lead'?'prep':'done');row.step=at.seg?.step??null;row.segmentIndex=at.seg?.index??null;row.screen=state.screen??'mark';}
  else if(state.recording){row.protocolSec=null;row.label=null;row.stage=null;row.step=null;row.segmentIndex=null;row.screen=state.screen??'mark';}
  state.latest=row;
  draw(result.landmarks);updateSetup(row,iris);
  if(state.recording){state.session.frames.push(row);state.dirty=true;}
  state.frames.push(now);state.frames=state.frames.filter(x=>now-x<2000);
  $('fps').textContent=`${(state.frames.length/2).toFixed(1)} fps`;
  $('quality').textContent=!portraitFrame?'縦持ちに戻してください':!pose?'顔が見つかりません':!faceValid?'顔を正面に近づけてください':!irisValid?'目を開き、明るい場所で近づいてください':!fresh?'顔を検出中／IMU未受信・遅延':'顔・虹彩・IMUを受信中';
  $('headDelta').textContent=signed(delta);
  $('cva').textContent=row.provisionalCva===null?'—':`${fmt(row.provisionalCva)}°`;
  $('distance').textContent=z===null?'—':`${fmt(z)} cm`;
  $('distanceMode').textContent=state.calibration?'1点校正済み・精度は未検証':'未校正・仮定した画角からの概算';
  $('ratio').textContent=ratio===null?'—':`${fmt(ratio,0)} %`;
  $('pitch').textContent=signed(pose?.pitch);$('yawRoll').textContent=`${signed(pose?.yaw)} / ${signed(pose?.roll)}`;
  $('deviceAngles').textContent=`${fmt(p.o?.beta)}° / ${fmt(p.o?.gamma)}°`;
  $('acceleration').textContent=[row.gx,row.gy,row.gz].map(x=>fmt(x,2)).join(' / ');
  $('rotationRate').textContent=[row.rotationAlpha,row.rotationBeta,row.rotationGamma].map(x=>fmt(x)).join(' / ');
  $('iris').textContent=`${fmt(iris?.left,2)} / ${fmt(iris?.right,2)}`;
  $('imuAge').textContent=age===null?'—':`${fmt(age,0)} ms`;$('latency').textContent=`${fmt(result.inferenceMs,0)} ms`;
  $('imuStatus').textContent=fresh?'IMU：方向を受信中':'IMU：方向未受信／遅延';
  $('baseline').disabled=!irisValid||!!state.collect||state.recording||state.recordStarting;
  $('calibrate').disabled=!irisValid||!!state.collect||state.recording||state.recordStarting;
  $('clearCalibration').disabled=!state.calibration||state.recording||state.recordStarting||!!state.collect;
  $('record').disabled=!state.baseline||state.recording||state.recordStarting||state.awaitingNext||!!state.collect||!!state.waiting;
  collectFrame(row);
}
function draw(lm){
  ctx.clearRect(0,0,canvas.width,canvas.height);
  if(!lm)return;
  ctx.strokeStyle='#70f0cf';ctx.lineWidth=Math.max(1,canvas.width/400);
  for(const indices of [[469,470,471,472],[474,475,476,477]]){ctx.beginPath();indices.forEach((i,j)=>{const p=lm[i];if(p)j?ctx.lineTo(p.x*canvas.width,p.y*canvas.height):ctx.moveTo(p.x*canvas.width,p.y*canvas.height);});ctx.closePath();ctx.stroke();}
  for(const i of [1,468,473])if(lm[i]){ctx.beginPath();ctx.arc(lm[i].x*canvas.width,lm[i].y*canvas.height,3,0,2*Math.PI);ctx.stroke();}
}
// ---- セットアップ画面：傾き → 高さ → 距離（固定のときだけ合否を判定。手持ちは目安）
function setItem(id,cls,value,note){const el=$(id);el.className=`setup-item ${cls}`;el.querySelector('b').textContent=value;el.querySelector('small').textContent=note;}
function updateSetup(row,iris){
  if(state.calib)return;
  const stand=$('holdMode').value==='stand',target=Number($('targetDistance').value)||40,w=canvas.width,h=canvas.height;
  // 映像の上に主点の高さの横線と、両目の中点を描く（CSSで鏡像表示しても横線と高さは変わらない）
  ctx.save();ctx.strokeStyle='#ffd34d';ctx.lineWidth=Math.max(2,w/240);ctx.setLineDash([w/40,w/60]);ctx.beginPath();ctx.moveTo(0,h/2);ctx.lineTo(w,h/2);ctx.stroke();ctx.setLineDash([]);
  if(iris){ctx.fillStyle='#ffd34d';ctx.beginPath();ctx.arc(iris.center[0]*w,iris.center[1]*h,Math.max(4,w/90),0,2*Math.PI);ctx.fill();}
  ctx.restore();
  // 直近 smoothMs の中央値で判定・表示する
  const now0=performance.now();state.setupBuf=(state.setupBuf||[]).filter(x=>x.t>=now0-SETUP.smoothMs);
  state.setupBuf.push({t:now0,lr:row.deviceTiltLRDeg,fb:row.deviceTiltFBDeg,dy:iris&&iris.p>0&&row.eyeOffsetYPx!==null?row.eyeOffsetYPx*SETUP.irisMm/iris.p/10:null,z:iris&&iris.p>0?row.zFocalCm:null});
  const sm=k=>{const v=state.setupBuf.map(x=>x[k]).filter(x=>x!==null&&Number.isFinite(x));return v.length?median(v):null;};
  const latch=state.setupLatch??={tilt:false,height:false,distance:false};
  const within=(key,v,tol)=>{const ok=Math.abs(v)<=tol*(latch[key]?SETUP.releaseFactor:1);latch[key]=ok;return ok;};
  const t=row.deviceTiltLRDeg===null?null:sm('lr'),fbk=row.deviceTiltFBDeg===null?null:sm('fb'),res={};
  if(t===null){setItem('setupTilt','ng','—','IMUの方向を受信していません');res.tilt=false;}
  else{
    res.tilt=within('tilt',Math.max(Math.abs(t),Math.abs(fbk)),SETUP.tiltTolDeg);
    const words=[Math.abs(t)>SETUP.tiltTolDeg?`上端が${t>0?'左':'右'}に${Math.abs(t).toFixed(1)}°`:'',Math.abs(fbk)>SETUP.tiltTolDeg?`上端が${fbk>0?'奥へ':'手前へ'}${Math.abs(fbk).toFixed(1)}°`:''].filter(Boolean).join('、');
    setItem('setupTilt',stand?(res.tilt?'ok':'ng'):'info',`左右 ${t.toFixed(1)}° 前後 ${fbk.toFixed(1)}°`,res.tilt?'垂直です':`${words}傾いています`);
  }
  if(!iris||!(iris.p>0)||sm('dy')===null){setItem('setupHeight','ng','—','両目が見えません');setItem('setupDistance','ng','—','両目が見えません');res.height=res.distance=false;latch.height=latch.distance=false;}
  else{
    // 目が横線より下に写る＝カメラが目より高い → スタンドを下げる
    const dyCm=sm('dy');res.height=within('height',dyCm,SETUP.heightTolCm);
    setItem('setupHeight',stand?(res.height?'ok':'ng'):'info',`${dyCm>=0?'+':''}${dyCm.toFixed(1)} cm`,res.height?'目の高さです':`スタンドを あと ${Math.abs(dyCm).toFixed(1)} cm ${dyCm>0?'下げる':'上げる'}`);
    const z=sm('z'),dz=z-target;res.distance=within('distance',dz,SETUP.distanceTolCm);
    setItem('setupDistance',stand?(res.distance?'ok':'ng'):'info',`${z.toFixed(1)} cm`,res.distance?`目標 ${target} cm です`:`あと ${Math.abs(dz).toFixed(1)} cm ${dz>0?'近づく':'離れる'}${row.focalSource==='charuco'?'':'（f 未校正）'}`);
    res.heightCm=dyCm;res.distanceCm=z;
  }
  const all=res.tilt&&res.height&&res.distance,now=performance.now();
  if(stand&&all){state.setupPassSince??=now;}else state.setupPassSince=null;
  const passed=stand&&all&&now-state.setupPassSince>=SETUP.stableMs;
  if(passed&&!state.setupPassed){beep(880,120);setTimeout(()=>beep(1320,180),160);}
  state.setupPassed=passed;
  state.setupLive={mode:stand?'stand':'hand',targetCm:target,tiltLRDeg:t,tiltFBDeg:fbk,heightOffsetCm:res.heightCm??null,distanceCm:res.distanceCm??null,
    tiltOK:!!res.tilt,heightOK:!!res.height,distanceOK:!!res.distance,passed,focalPx:row.focalPx,focalSource:row.focalSource,irisMmAssumed:SETUP.irisMm};
  $('setupStatus').textContent=!stand?'手持ち：高さと距離は目安です。基準の姿勢で「この姿勢を基準にする」を押してください。':passed?'セットアップ合格。そのまま「この姿勢を基準にする（3秒）」を押してください。':`固定：①傾き → ②高さ → ③距離 の順に合わせてください（目安：傾き±${SETUP.tiltTolDeg}°、高さ±${SETUP.heightTolCm} cm、距離±${SETUP.distanceTolCm} cm）。3つとも緑になると音が鳴ります。緑にならなくても基準は記録できます（実際の値は記録に残ります）。`;
  if(!state.recording&&!state.collect){
    const b=$('previewBadge');b.hidden=false;
    const mark=(ok,txt)=>stand?`<span class="${ok?'ok':'ng'}">${ok?'✓':'×'} ${txt}</span>`:txt;
    b.innerHTML=passed?'<span class="ok big">✓ セットアップ合格</span>':[mark(res.tilt,`傾き ${t===null?'—':`${t.toFixed(1)}° / ${fbk.toFixed(1)}°`}`),mark(res.height,`高さ ${res.heightCm===undefined?'—':`${res.heightCm>=0?'+':''}${res.heightCm.toFixed(1)} cm`}`),mark(res.distance,`距離 ${res.distanceCm===undefined?'—':`${res.distanceCm.toFixed(1)} cm`}`)].join('<br>');
  }else $('previewBadge').hidden=true;
}

// ---- カメラ校正（ChArUco）。OpenCV.js は校正を始めたときだけ読み込む
function refreshCalibStatus(){
  const c=loadCameraCalibration(),w=canvas.width,h=canvas.height;
  if(c&&!state.calib&&!refreshCalibStatus.opened){$('calibCard').open=false;refreshCalibStatus.opened=true;}   // 校正済みなら最初は閉じておく
  $('calibExport').disabled=!c;$('calibClear').disabled=!c;
  if(!c){$('calibStatus').textContent='未校正です。校正するまでは、仮の画角から求めた f を使います。';return;}
  const same=!state.running||(c.width===w&&c.height===h);
  $('calibStatus').textContent=`校正済み：f = ${c.focalPx.toFixed(1)} px（再投影誤差 ${c.rmsPx.toFixed(2)} px、${c.width}×${c.height}、${new Date(c.createdAt).toLocaleString('ja-JP')}）${same?'':` ／ 注意：いまの解像度（${w}×${h}）と違うため使いません。校正し直してください。`}`;
  $('calibStatus').classList.toggle('error',!same);
}
async function startCalibration(){
  if(!state.running||state.calib||state.recording||state.collect)return;
  const squareMm=Number($('squareMm').value);
  if(!(squareMm>=10&&squareMm<=100)){status('マスの実寸を10〜100 mmで入力してください。',true);return;}
  $('calibStart').disabled=true;$('calibCancel').disabled=false;
  $('calibStatus').textContent='OpenCV.js を読み込んでいます（初回は数十秒かかります）…';
  try{
    const mod=await import('./calib.js'),{cv}=await mod.loadOpenCV();
    if(!state.running)return;
    const w=video.videoWidth,h=video.videoHeight,fGuess=w/(2*Math.tan(rad(60)/2));
    const grab=document.createElement('canvas');grab.width=w;grab.height=h;
    state.calib={mod,cv,cal:new mod.CharucoCalibrator(cv,{squareMm,width:w,height:h,fGuess}),grab,gctx:grab.getContext('2d',{willReadFrequently:true}),last:0,startedAt:new Date().toISOString(),squareMm};
    ctx.clearRect(0,0,canvas.width,canvas.height);document.querySelector('.preview').scrollIntoView({behavior:'smooth',block:'start'});
    status('カメラ校正中です。ボードを前でゆっくり動かしてください（向きと位置を変えながら、少し斜めに）。');
    requestAnimationFrame(calibTick);
  }catch(e){$('calibStatus').textContent=`校正を始められません：${e.message}`;$('calibStatus').classList.add('error');endCalibration();}
}
function calibTick(t){
  const c=state.calib;if(!c||!state.running)return;
  requestAnimationFrame(calibTick);
  if(t-c.last<c.mod.CALIB_RULES.intervalMs||video.readyState<2)return;
  c.last=t;
  c.gctx.drawImage(video,0,0,c.grab.width,c.grab.height);
  let r;try{r=c.cal.process(c.gctx.getImageData(0,0,c.grab.width,c.grab.height));}catch(e){$('calibStatus').textContent=`検出でエラー：${e.message||e}`;return;}
  ctx.clearRect(0,0,canvas.width,canvas.height);ctx.fillStyle=r.accepted?'#8ff0cf':'#ffd34d';
  for(const q of r.img)ctx.fillRect(q[0]-5,q[1]-5,10,10);
  const n=c.cal.views.length,N=c.mod.CALIB_RULES.targetFrames;
  if(r.accepted)beep(1200,90);
  const b=$('previewBadge');b.hidden=false;
  b.innerHTML=`<span class="big">${n} / ${N} 枚</span><br>角 ${r.ids.length}/12${r.tiltDeg!==undefined?`・傾き ${r.tiltDeg.toFixed(0)}°`:''}<br>${r.accepted?'<span class="ok">採用しました</span>':r.reason||''}`;
  $('calibStatus').textContent=`採用 ${n}/${N} 枚。${r.accepted?'採用しました。':r.reason||''}`;
  if(n>=N)finishCalibration();
}
function finishCalibration(){
  const c=state.calib;if(!c)return;
  $('calibStatus').textContent='計算しています…';
  const r=c.cal.compute();
  if(!r.focalPx){$('calibStatus').textContent=`計算できませんでした：${r.error}。もう一度校正してください。`;$('calibStatus').classList.add('error');endCalibration();return;}
  const result={app:`posture-lab/${APP_VERSION}`,createdAt:new Date().toISOString(),startedAt:c.startedAt,width:c.cal.width,height:c.cal.height,
    focalPx:r.focalPx,rmsPx:r.rmsPx,passed:r.ok,method:r.method,opencvVersion:c.mod.OPENCV_VERSION,board:{...c.mod.BOARD,squareMm:c.squareMm,legacyPatternUsed:r.legacyPattern},
    model:'pinhole; principal point fixed at image centre; fx = fy; zero distortion',rules:c.mod.CALIB_RULES,frames:r.frames,corners:r.corners,
    opencv:r.opencv,own:r.own,opencvError:r.opencvError,ownMinusOpencvPercent:r.ownMinusOpencvPercent,
    hfovDeg:2*deg(Math.atan(c.cal.width/2/r.focalPx)),browser:navigator.userAgent,views:c.cal.views};
  if(r.ok){
    camCalCache=undefined;try{localStorage.setItem(CAMERA_CALIB_KEY,JSON.stringify(result));}catch(e){status(`校正結果を端末に保存できません：${e.message}`,true);}
    beep(880,120);setTimeout(()=>beep(1320,220),160);
    status(`カメラ校正に合格しました：f = ${r.focalPx.toFixed(1)} px（再投影誤差 ${r.rmsPx.toFixed(2)} px）。`);
  }else{
    state.lastFailedCalibration=result;
    status(`再投影誤差が ${r.rmsPx.toFixed(2)} px で、合格（1 px未満）になりませんでした。ボードを平らにして、もう一度校正してください。`,true);
  }
  endCalibration();refreshCalibStatus();
  if(!r.ok)$('calibStatus').textContent=`不合格：f = ${r.focalPx.toFixed(1)} px、再投影誤差 ${r.rmsPx.toFixed(2)} px（1 px未満で合格）。保存していません。`;
}
function endCalibration(){
  state.calib?.cal?.dispose();state.calib=null;
  $('calibStart').disabled=!state.running;$('calibCancel').disabled=true;$('previewBadge').hidden=true;
  ctx.clearRect(0,0,canvas.width,canvas.height);
}
$('calibStart').addEventListener('click',()=>{beep(440,1,.001);startCalibration();});
$('calibCancel').addEventListener('click',()=>{endCalibration();status('カメラ校正を中止しました。');refreshCalibStatus();});
$('calibClear').addEventListener('click',()=>{camCalCache=undefined;try{localStorage.removeItem(CAMERA_CALIB_KEY);}catch{}refreshCalibStatus();status('カメラ校正を消去しました。仮の画角に戻ります。');});
$('calibExport').addEventListener('click',()=>{const c=loadCameraCalibration();if(c)download(`camera-calibration-${c.createdAt.replace(/[:.]/g,'-')}.json`,JSON.stringify(c,null,1),'application/json');});
refreshCalibStatus();
$('condition').addEventListener('change',applyCondition);restoreSubject();applyCondition();

function clearValues(){for(const id of ['headDelta','cva','distance','ratio','pitch','yawRoll','deviceAngles','acceleration','rotationRate','iris','imuAge','latency'])$(id).textContent='—';ctx.clearRect(0,0,canvas.width,canvas.height);}

function startCollection(type){
  if(!state.running||state.collect||state.recording)return;
  const distance=Number($('knownDistance').value);
  if(type==='distance'&&(!Number.isFinite(distance)||distance<15||distance>100)){status('実測距離を15〜100 cmの範囲で入力してください。',true);return;}
  state.collect={type,start:performance.now(),rows:[],distance};
  status(type==='baseline'?'基準を記録しています。顔と端末を3秒間静止させてください。':'距離を校正しています。目を画面中央に置き、実測距離を維持してください。');
}
$('baseline').addEventListener('click',()=>startCollection('baseline'));
$('calibrate').addEventListener('click',()=>startCollection('distance'));
$('clearCalibration').addEventListener('click',()=>{state.calibration=null;$('calibrationStatus').textContent='校正を解除しました。画角を仮定した概算に戻ります。';});
function collectFrame(row){
  const c=state.collect;if(!c)return;
  const centered=Math.abs(row.eyeX-.5)<.12&&Math.abs(row.eyeY-.5)<.15;
  if(row.irisValid&&(c.type!=='distance'||centered))c.rows.push(row);
  const elapsed=performance.now()-c.start;
  status(`${c.type==='baseline'?'基準姿勢を記録':'距離を校正'}：あと${Math.max(0,Math.ceil((3000-elapsed)/1000))}秒（有効${c.rows.length}フレーム）`);
  if(elapsed<3000)return;
  state.collect=null;
  const rows=c.rows,diameters=rows.map(r=>r.irisPx),heads=rows.filter(r=>r.headInclination!==null).map(r=>r.headInclination);
  if(rows.length<15||rows.at(-1).t-rows[0].t<2000||sd(diameters)/mean(diameters)>.07||(heads.length>2&&sd(heads)>3)){
    status('安定したデータが不足しています。顔と端末を静止させ、目を中央付近に置いてもう一度操作してください。',true);return;
  }
  const irisPx=median(diameters);
  if(c.type==='baseline'){
    const head=heads.length>=Math.max(15,rows.length*.8)?median(heads):null;
    const md=k=>{const v=rows.map(r=>r[k]).filter(x=>x!==null&&x!==undefined);return v.length?median(v):null;};
    const sl=state.setupLive,uv=['upX','upY','upZ'].map(md),un=uv.every(x=>x!==null)?Math.hypot(...uv):0;
    state.baseline={t:performance.now(),irisPx,head,frames:rows.length,validImuFrames:heads.length,...config(),up:un>0?uv.map(x=>x/un):null,
      setup:{mode:$('holdMode').value,targetCm:Number($('targetDistance').value)||40,passedAtStart:!!sl?.passed,tiltLRDeg:md('deviceTiltLRDeg'),tiltFBDeg:md('deviceTiltFBDeg'),
        heightOffsetCm:irisPx>0&&md('eyeOffsetYPx')!==null?md('eyeOffsetYPx')*SETUP.irisMm/irisPx/10:null,distanceCm:md('zFocalCm'),focalPx:md('focalPx'),focalSource:rows.at(-1).focalSource,irisMmAssumed:SETUP.irisMm,tolerances:{...SETUP}}};
    $('baselineStatus').textContent=head===null?'基準取得済み。ただしIMU不足のため距離比のみ。IMU許可後に取り直してください。':`基準取得済み（${rows.length}フレーム）。表示を基準からの変化に切り替えました。`;
    status(head===null?'基準の距離比を記録しました。頭部補正にはIMUの受信が必要です。':'基準を記録しました。姿勢や端末の向きをゆっくり変えてください。');
  }else{
    state.calibration={t:performance.now(),knownDistanceCm:c.distance,irisPx,k:c.distance*irisPx,width:canvas.width,height:canvas.height,frames:rows.length};
    $('calibrationStatus').textContent=`${c.distance.toFixed(1)} cmで校正済み（${rows.length}フレーム）。カメラ設定・被験者が変わったら校正し直してください。`;
    status('距離を校正しました。焦点距離を個別に求めず、虹彩径の比で奥行きを算出します。');
  }
}
function invalidate(message){
  dismissNextRecord();
  if(state.recording)endRecord('baseline_invalidated');
  state.baseline=null;state.collect=null;
  $('record').disabled=true;
  $('baselineStatus').textContent='基準姿勢：取り直しが必要です';clearValues();status(message,true);
}
window.addEventListener('orientationchange',()=>{if(state.running)invalidate('端末の縦横が変わりました。縦持ちに戻し、基準を取り直してください。');});
screen.orientation?.addEventListener('change',()=>{if(state.running)invalidate('画面の向きが変わりました。縦持ちで基準を取り直してください。');});
document.addEventListener('visibilitychange',()=>{
  if(document.hidden){if(state.waiting)cancelWaiting('page_hidden');if(state.recording)endRecord('page_hidden');state.collect=null;clearValues();}
  else if(state.running){status('画面に戻りました。記録は自動再開しません。必要に応じて基準を取り直してください。');wake();}
});
for(const id of ['hfov','irisMm'])$(id).addEventListener('change',()=>{
  const el=$(id);if(!el.checkValidity()||!el.value){el.value=id==='hfov'?'60':'11.7';status('入力範囲外のため初期値に戻しました。',true);}
});

// Append-only checkpoints: keep capture callbacks free of large JSON writes.
let dbPromise;
function db(){
  return dbPromise??=new Promise((resolve,reject)=>{
    let expired=false;
    const timeout=setTimeout(()=>{expired=true;reject(Error('端末内保存の応答がありません。別タブで同じページを開いている場合は閉じてください。'));},8000);
    const r=indexedDB.open('posture-lab-checkpoint',2);
    r.onupgradeneeded=()=>{
      if(!r.result.objectStoreNames.contains('chunks'))r.result.createObjectStore('chunks',{keyPath:'id'});
      if(!r.result.objectStoreNames.contains('archives'))r.result.createObjectStore('archives',{keyPath:'id'});
    };
    r.onsuccess=()=>{clearTimeout(timeout);if(expired){r.result.close();return;}r.result.onversionchange=()=>{r.result.close();dbPromise=null;};resolve(r.result);};
    r.onerror=()=>{clearTimeout(timeout);reject(r.error);};
  }).catch(e=>{dbPromise=null;throw e;});
}
function finishTransaction(tx){
  return new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>{try{tx.abort();}catch{}reject(Error('端末内保存がタイムアウトしました。'));},8000);
    tx.oncomplete=()=>{clearTimeout(timeout);resolve();};
    tx.onerror=tx.onabort=()=>{clearTimeout(timeout);reject(tx.error||Error('端末内保存が中断されました。'));};
  });
}
function checkpoint(reset=false){
  if(!state.session)return Promise.resolve();
  if(state.saveBusy)return state.saveTask;
  state.saveTask=writeCheckpoint(reset);return state.saveTask;
}
async function writeCheckpoint(reset){
  state.saveBusy=true;
  const s=state.session;
  try{
    const d=await db();
    const counts=Object.fromEntries(['frames','motion','orientation','events','inputs'].map(k=>[k,(s[k]||[]).length]));
    const chunk={id:state.chunk};for(const k of Object.keys(counts))chunk[k]=(s[k]||[]).slice(reset?0:(state.saved[k]||0),counts[k]);
    const tx=d.transaction('chunks','readwrite'),store=tx.objectStore('chunks');
    const done=finishTransaction(tx);
    if(reset)store.clear();
    store.put({id:0,meta:s.meta});store.put(chunk);
    await done;
    state.saved=counts;state.chunk++;state.storageOK=true;state.lastCheckpoint=performance.now();
  }catch{state.storageOK=false;}
  finally{state.saveBusy=false;}
}
function lockSettings(locked){for(const id of ['hfov','irisMm','knownDistance','holdMode','targetDistance','squareMm','subjId','condition','runNo','memo','protocolKind','startMethod'])$(id).disabled=locked;$('calibStart').disabled=locked||!state.running;}
$('record').addEventListener('click',()=>{
  if(state.recording||state.recordStarting||!state.running||!state.baseline)return;
  const subj=subjectForm(),bad=checkSubject(subj);if(bad){status(bad,true);return;}
  if(state.dirty){
    state.awaitingNext=true;$('nextRecordPanel').hidden=false;$('record').disabled=true;
    $('nextRecordNote').textContent=state.session?.meta.exports?.csvRequestedAt?'CSVの保存操作は済んでいます。全記録JSONの保存操作はまだ行われていません。':'前回の記録の保存操作はまだ行われていません。';
    return;
  }
  startRecording();
});
function dismissNextRecord(){state.awaitingNext=false;$('nextRecordPanel').hidden=true;}
$('cancelNextRecord').addEventListener('click',dismissNextRecord);
$('continueRecord').addEventListener('click',()=>{dismissNextRecord();startRecording();});
async function startRecording(){
  if(state.recording||state.recordStarting||state.waiting||!state.running||!state.baseline||state.collect)return;
  prepareAudio();   // 押した操作の中で音を使えるようにする（iOS）
  state.recordStarting=true;$('record').disabled=true;$('continueRecord').disabled=true;
  $('sessionSelect').disabled=true;$('exportCsv').disabled=true;$('exportJson').disabled=true;
  const generation=state.generation,baseline=state.baseline;
  try{
    // Called directly by a user gesture. Resume the preview after a download UI.
    await new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(Error('カメラ映像が再開しません。記録を保存してからカメラを再起動してください。')),8000);
      video.play().then(()=>{clearTimeout(timeout);resolve();},e=>{clearTimeout(timeout);reject(e);});
    });
    if(state.saveTask)await state.saveTask;
    if(state.session){
      status('前の記録を端末内に退避しています。カメラ計測は継続します。');
      await archiveSession(state.session);
    }else if(recovery?.length){
      await archiveSession(recoveredSession());
    }
    if(!state.running||document.hidden||generation!==state.generation||state.baseline!==baseline)return;
    if($('protocolKind').value==='none'){beginSession();afterBegin();}
    else enterWaiting();   // 0.4.0：合図待ち（音の合図か、手動のカウントダウンで beginSession）
  }catch(e){status(`次の記録を開始できませんでした：${e.message} 前の記録は保持しています。CSV／JSONを保存できます。`,true);}
  finally{
    state.recordStarting=false;$('continueRecord').disabled=false;refreshSessionSelect();
    $('exportCsv').disabled=state.recording||!selectedSession();$('exportJson').disabled=state.recording||!selectedSession();
  }
}
function afterBegin(){
  // A checkpoint failure must not suspend live capture or leave the UI locked.
  checkpoint(true);updateRecording();if(state.session.meta.baselineAgeSec<QUALITY.baselineMaxAgeSec)status('新しい記録を開始しました。');
}
function beginSession(sync=null){
  const subject=subjectForm(),stamp=new Date().toISOString().replace(/[:.]/g,'-');
  try{localStorage.setItem(SUBJECT_KEY,JSON.stringify(subject));}catch{}
  // ファイル名：P01_fixed1_posture_<時刻>
  const id=checkSubject(subject)?`posture-${stamp}`:`${subject.id}_${subject.condition}${subject.run}_posture_${stamp}`;
  const clock={dateNowMs:Date.now(),perfNowMs:performance.now(),timeOrigin:performance.timeOrigin,note:'記録開始時の Date.now() と performance.now() の組。2台の時計のずれを後で見積もるため'};
  state.session={meta:{id,version:APP_VERSION,subject,clock,createdAt:new Date().toISOString(),exports:{},timeOrigin:performance.timeOrigin,start:performance.now(),browser:navigator.userAgent,mediapipeVersion:MP_VERSION,model:MODEL,settings:state.cameraSettings,inference:state.mode,config:config(),baseline:{...state.baseline},distanceCalibration:state.calibration?{...state.calibration}:null,
    protocolVersion:PP.PROTOCOL_VERSION,protocolKind:sync?.kind??'none',timetable:sync?sync.sch:null,startMethod:sync?.method??'button',
    sync:sync?{method:sync.method,t0:sync.t0,t0WallMs:Date.now()-(performance.now()-sync.t0),detail:sync.detail??null,mic:state.mic?.settings??null}:null,
    holdMode:$('holdMode').value,setup:state.baseline?.setup??null,focal:(()=>{const f=focal();return {focalPx:f.f,source:f.source,resolutionMismatch:!!f.mismatch};})(),cameraCalibration:(()=>{const c=loadCameraCalibration();if(!c)return null;const{views,...rest}=c;return rest;})(),
    units:{time:'milliseconds relative to performance.timeOrigin',videoTime:'seconds in video timeline; not hardware exposure timestamp',angles:'degrees',distance:'cm',iris:'source image px',acceleration:'m/s^2',rotationRate:'deg/s'},
    limitations:['unvalidated prototype','portrait front camera only','orientation matched by latest receive time, not hardware synchronization','provisional CVA model is not an observed anatomical CVA','iris distance does not separate phone motion from head motion'],qualityRules:{orientationMaxAgeMs:250,yawMaxDeg:25,pitchMaxDeg:40,rollMaxDeg:25,irisMinPx:5,minEyeAspectRatio:.12,minLeftRightRatio:.65}},frames:[],motion:[],orientation:[],events:[],inputs:recentInputs()};
  state.saved={frames:0,motion:0,orientation:0,events:0,inputs:0};state.chunk=1;state.standWatch={moved:false,count:0,max:0,maxAtSec:null,ref:null,acc:[0,0,0],n:0};$('qualityBox').hidden=true;
  const bAge=(state.session.meta.start-state.baseline.t)/1000;state.session.meta.baselineAgeSec=bAge;
  state.timetable=sync?{sch:sync.sch,t0:sync.t0,method:sync.method,lastKey:null,page:null}:null;state.screen='mark';
  if(sync){const rt=chooseReadingText(subject.id,subject.run);state.timetable.reading=rt;   // 0.4.0：読書の区間だけ表示する文章（被験者・回で選ぶ）
    state.session.meta.reading={version:READING_TEXTS_VERSION,textId:rt.id,textIndex:rt.index,title:rt.title,rule:rt.rule,pageSec:sync.sch.sec.readingPage,pages:rt.pages.length,text:rt.pages,shownDuring:'読書 hold'};}
  state.recording=true;state.dirty=true;event('record_start',{baselineAgeSec:bAge});
  if(sync)event(sync.method==='tone'?'sync_tone_start':'manual_start',{t:sync.t0,wallMs:state.session.meta.sync.t0WallMs,...(sync.detail??{})});lockSettings(true);wake();   // 記録中は画面を消さない
  if(bAge>=QUALITY.baselineMaxAgeSec){event('baseline_stale',{baselineAgeSec:bAge});status(`基準（「この姿勢を基準にする」）が ${(bAge/60).toFixed(0)}分前のものです。この回を止めて、基準を取り直してから記録してください。`,true);}
  setRecordingScreen(true,bAge>=QUALITY.baselineMaxAgeSec?bAge:null);
  $('record').disabled=true;$('endRecord').disabled=false;
  $('exportCsv').disabled=true;$('exportJson').disabled=true;
  refreshSessionSelect();$('sessionSelect').value='current';$('sessionSelect').disabled=true;updateSaveStatus();
}
// ---- 終了時の品質判定。h が出たフレーム＝headInclinationRaw（有効範囲外でも数える）。固定では基準時の上向きで補った値も数える
// 0.2.1：判定の対象は「顔が写っている」フレームだけ（顔が写っていない時間は IMU や計算の失敗ではないので、別に表示する）
function runsOf(fr,test,t1){   // test を満たすフレームが続いた区間 [{start,end}]（end は次のフレームの時刻。最後まで続けば t1）
  const out=[];let st=null;
  for(let i=0;i<fr.length;i++){const ok=test(fr[i]);if(ok&&st===null)st=fr[i].t;if(!ok&&st!==null){out.push({start:st,end:fr[i].t});st=null;}}
  if(st!==null)out.push({start:st,end:t1});return out;
}
function judgeQuality(s){
  const fr=s.frames,t0=s.meta.start,t1=s.meta.end??performance.now(),dur=(t1-t0)/1000,stand=s.meta.holdMode==='stand';
  const hasH=r=>r.headInclinationRaw!==null||(stand&&r.headInclinationFixedUp!==null);
  const face=r=>!!r.faceDetected;
  const rate=(a,f)=>a.length?a.filter(f).length/a.length:null;
  const gapList=list=>{const g=[];for(let i=1;i<list.length;i++){const d=list[i].t-list[i-1].t;if(d>QUALITY.imuGapMs)g.push({start:list[i-1].t,end:list[i].t});}return g;};
  const gaps=list=>{let m=0;for(let i=1;i<list.length;i++)m=Math.max(m,list[i].t-list[i-1].t);return {count:gapList(list).length,maxMs:Math.round(m)};};
  // 5秒窓を0.5秒ずつずらし、窓ごとに「顔が写っているフレームのうち h が出た割合」を求める（顔が写ったフレームがない窓は除く）
  let worst=null,worstAll=null;
  for(let a=0;a+QUALITY.windowSec<=dur+1e-9;a+=QUALITY.windowStepSec){
    const w=fr.filter(r=>r.t>=t0+a*1000&&r.t<t0+(a+QUALITY.windowSec)*1000),wf=w.filter(face);
    const ra=w.length?w.filter(hasH).length/w.length:0;
    if(!worstAll||ra<worstAll.rate)worstAll={rate:ra,startSec:+a.toFixed(1),frames:w.length};
    if(!wf.length)continue;
    const r=wf.filter(hasH).length/wf.length;
    if(!worst||r<worst.rate)worst={rate:r,startSec:+a.toFixed(1),frames:wf.length};
  }
  // 「顔が写っているのに h が出ない」が続いた最長の時間（顔が写っていないフレームで区切る）
  let gap={sec:0,startSec:0};
  for(const g of runsOf(fr,r=>face(r)&&!hasH(r),t1)){const sec=(g.end-g.start)/1000;if(sec>gap.sec)gap={sec,startSec:(g.start-t0)/1000};}
  // 顔が写っていない時間（判定には使わない。どの姿勢で外れたかを確かめるため）
  const noFace=runsOf(fr,r=>!face(r),t1).map(g=>({startSec:(g.start-t0)/1000,endSec:(g.end-t0)/1000,sec:(g.end-g.start)/1000})).filter(g=>g.sec>=QUALITY.noFaceMinSec);
  // IMU の途切れが画面の操作（タッチ・スクロール）と重なったか
  const inputs=s.inputs||[],near=g=>inputs.some(e=>e.t>=g.start-QUALITY.touchNearMs&&e.t<=g.end+QUALITY.touchNearMs);
  const detail=list=>gapList(list).map(g=>({startSec:+((g.start-t0)/1000).toFixed(2),sec:+((g.end-g.start)/1000).toFixed(2),touch:near(g)}));
  const imuGapList={orientation:detail(s.orientation),motion:detail(s.motion)};
  const imuGaps={orientation:{...gaps(s.orientation),withTouch:imuGapList.orientation.filter(g=>g.touch).length},motion:{...gaps(s.motion),withTouch:imuGapList.motion.filter(g=>g.touch).length}};
  const touchesDuringRecord=inputs.filter(e=>e.t>=t0&&e.t<=t1&&/start|down/.test(e.type)).length;
  const sw=state.standWatch||{count:0,max:0,maxAtSec:null},standEvents=s.events.filter(e=>e.type==='stand_moved').length;
  const reasons=[],warnings=[];
  if(worst&&worst.rate<QUALITY.minWindowRate)reasons.push(`顔が写っているのに h が出ないフレームが多い窓があります：${worst.startSec.toFixed(1)}〜${(worst.startSec+QUALITY.windowSec).toFixed(1)}秒で h が出たのは ${Math.round(worst.rate*100)}%（${Math.round(QUALITY.minWindowRate*100)}%以上が必要）`);
  if(gap.sec>=QUALITY.maxHGapSec)reasons.push(`顔が写っているのに h が ${gap.sec.toFixed(1)}秒 出ませんでした（${gap.startSec.toFixed(1)}秒から。${QUALITY.maxHGapSec}秒未満が必要）`);
  if(stand&&standEvents)reasons.push(`スタンドの傾きが記録開始時から ${QUALITY.standMoveDeg}°を超えて変わりました（${standEvents}回、最大 ${sw.max.toFixed(1)}°、${sw.maxAtSec?.toFixed(1)}秒）`);
  if(!worstAll)reasons.push(`記録が短すぎます（${QUALITY.windowSec}秒未満）`);
  else if(!worst)reasons.push('顔が一度も写っていません');
  if((s.meta.baselineAgeSec??0)>=QUALITY.baselineMaxAgeSec)warnings.push(`基準が記録開始の ${(s.meta.baselineAgeSec/60).toFixed(0)}分前のものでした。回ごとに基準を取り直してください`);
  if(noFace.length)warnings.push(`顔が写っていない時間：${noFace.map(g=>`${g.startSec.toFixed(1)}〜${g.endSec.toFixed(1)}秒（${g.sec.toFixed(1)}秒）`).join('、')}`);
  return {ok:!reasons.length,verdict:reasons.length?'やり直し推奨':warnings.length?'注意':'OK',reasons,warnings,rules:{...QUALITY,hCounted:stand?'headInclinationRaw or headInclinationFixedUp':'headInclinationRaw',framesCounted:'faceDetected',standReference:'record_start'},
    durationSec:dur,frames:fr.length,fps:fr.length/Math.max(dur,1e-9),
    faceDetectedRate:rate(fr,face),faceValidRate:rate(fr,r=>r.faceValid),irisValidRate:rate(fr,r=>r.irisValid),imuValidRate:rate(fr,r=>r.imuValid),imuAnyRate:rate(fr,r=>r.imuSource!==null),
    hRate:rate(fr,hasH),hRateFace:rate(fr.filter(face),hasH),hRawRate:rate(fr,r=>r.headInclinationRaw!==null),headInclinationRate:rate(fr,r=>r.headInclination!==null),
    worstWindow:worst,worstWindowAllFrames:worstAll,longestHGap:{sec:gap.sec,startSec:gap.startSec,framesCounted:'faceDetected'},noFace,imuGaps,imuGapList,touchesDuringRecord,
    baselineAgeSec:s.meta.baselineAgeSec??null,
    standMoved:stand?{events:standEvents,maxDeg:sw.max,maxAtSec:sw.maxAtSec,reference:'record_start'}:null};
}
function showQuality(q){
  const pc=x=>x===null||x===undefined?'—':`${Math.round(x*100)}%`,box=$('qualityBox');box.hidden=false;box.className=`quality ${q.ok?(q.warnings?.length?'warn':'ok'):'ng'}`;
  const list=a=>a.length?`<ul>${a.map(r=>`<li>${r}</li>`).join('')}</ul>`:'';
  const gl=q.imuGapList,touchLine=k=>`${q.imuGaps[k].count}回・最長 ${(q.imuGaps[k].maxMs/1000).toFixed(1)}秒（うちタッチと重なった ${q.imuGaps[k].withTouch}回）`;
  const gapTimes=gl.orientation.length?gl.orientation.map(g=>`${g.startSec.toFixed(1)}秒（${g.sec.toFixed(1)}秒${g.touch?'・タッチあり':''}）`).join('、'):'なし';
  box.innerHTML=`<strong>${q.verdict}</strong>${list(q.reasons)}${q.ok?'':'<span>この回だけやり直してください。</span>'}${list(q.warnings||[])}
    <dl><dt>h が出た率（顔が写っているフレーム）</dt><dd>${pc(q.hRateFace)}（全体 ${pc(q.hRate)}）</dd><dt>最も悪い5秒窓</dt><dd>${q.worstWindow?`${pc(q.worstWindow.rate)}（${q.worstWindow.startSec.toFixed(1)}秒〜）`:'—'}</dd>
    <dt>h の最長の途切れ（顔あり）</dt><dd>${q.longestHGap.sec.toFixed(1)}秒（${q.longestHGap.startSec.toFixed(1)}秒〜）</dd><dt>顔が写っている</dt><dd>${pc(q.faceDetectedRate)}（有効範囲内 ${pc(q.faceValidRate)}）</dd><dt>IMU（方向）が有効</dt><dd>${pc(q.imuValidRate)}</dd>
    <dt>fps</dt><dd>${q.fps.toFixed(1)}</dd><dt>IMUの途切れ（250 ms超）</dt><dd>方向 ${touchLine('orientation')} ／ 加速度 ${touchLine('motion')}</dd>
    <dt>方向の途切れの時刻</dt><dd>${gapTimes}</dd><dt>記録中のタッチ</dt><dd>${q.touchesDuringRecord}回</dd>
    ${q.standMoved?`<dt>スタンドの動き（記録開始時から）</dt><dd>${q.standMoved.events}回（最大 ${q.standMoved.maxDeg.toFixed(1)}°${q.standMoved.maxAtSec!==null?`、${q.standMoved.maxAtSec.toFixed(1)}秒`:''}）</dd>`:''}</dl>`;
}
function endRecord(reason='user'){
  if(!state.recording)return;
  event('record_stop',{reason});state.recording=false;setRecordingScreen(false);state.session.meta.end=performance.now();state.session.meta.stopReason=reason;
  state.session.meta.quality=judgeQuality(state.session);showQuality(state.session.meta.quality);
  lockSettings(false);$('endRecord').disabled=true;$('exportCsv').disabled=false;$('exportJson').disabled=false;
  refreshSessionSelect();updateSaveStatus();
  checkpoint();updateRecording();
  const tt=state.timetable;state.timetable=null;
  if(reason==='protocol_end'){const s=state.session;archiveSession(s).then(()=>status('進行表の最後まで進み、自動で停止しました。端末内に保存しました。CSV・JSON は「計測CSVを保存」「全記録JSONを保存」で書き出してください。')).catch(e=>status(`自動で停止しましたが、端末内への保存に失敗しました：${e.message} すぐに CSV・JSON を書き出してください。`,true));}
  if(tt)stopMic();
}
longPress($('endRecord'),()=>endRecord());longPress($('overlayStop'),()=>endRecord());
// ---- 記録中の画面（0.2.1）：スクロールを止め、「画面に触れないでください」を表示。停止は1秒の長押し
// iOS では、タッチやスクロールの処理中に方向・加速度のイベントが止まる可能性があるため
function longPress(el,fn){
  let timer=null;const cancel=()=>{clearTimeout(timer);timer=null;el.classList.remove('holding');};
  el.addEventListener('pointerdown',e=>{if(el.disabled)return;e.preventDefault();cancel();el.classList.add('holding');timer=setTimeout(()=>{cancel();fn();},QUALITY.stopHoldMs);});
  for(const t of ['pointerup','pointercancel','pointerleave'])el.addEventListener(t,cancel);
  el.addEventListener('contextmenu',e=>e.preventDefault());
  el.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();if(!timer){el.classList.add('holding');timer=setTimeout(()=>{cancel();fn();},QUALITY.stopHoldMs);}}});
  el.addEventListener('keyup',cancel);
}
let savedScrollY=0;
function setRecordingScreen(on,staleSec=null){
  const ov=$('recordOverlay');
  clearInterval(state.readingTimer);
  if(on){savedScrollY=window.scrollY;document.body.style.top=`-${savedScrollY}px`;document.documentElement.classList.add('recording');ov.hidden=false;
    setScreen('mark');
    $('overlayWarn').hidden=staleSec===null;if(staleSec!==null)$('overlayWarn').textContent=`基準が ${(staleSec/60).toFixed(0)}分前のものです。停止して、基準を取り直してください。`;}
  else if(!ov.hidden){document.documentElement.classList.remove('recording');document.body.style.top='';ov.hidden=true;window.scrollTo(0,savedScrollY);}
}
// タッチ・スクロール・ポインターを時刻つきで記録（記録の直前5秒も残す：記録開始のボタン操作を含めるため）
const INPUT_PRE_MS=5000,preInputs=[];
function recentInputs(){const t=performance.now();return preInputs.filter(e=>e.t>=t-INPUT_PRE_MS);}
function logInput(e){
  const pt=e.touches?.[0]??e.changedTouches?.[0]??e,rec={t:performance.now(),type:e.type,eventTimeStamp:e.timeStamp,x:n(pt.clientX),y:n(pt.clientY),pointerType:e.pointerType??null,touches:e.touches?.length??null,target:e.target?.id||e.target?.tagName||null};
  if(e.type==='scroll'){rec.scrollY=window.scrollY;rec.x=rec.y=null;}
  if(state.recording)state.session.inputs.push(rec);else{preInputs.push(rec);while(preInputs.length&&preInputs[0].t<rec.t-INPUT_PRE_MS)preInputs.shift();}
}
for(const t of ['touchstart','touchend','touchcancel','pointerdown','pointerup','pointercancel'])document.addEventListener(t,logInput,{capture:true,passive:true});
window.addEventListener('scroll',logInput,{passive:true});
document.addEventListener('touchmove',e=>{if(state.recording)e.preventDefault();},{passive:false});
// 計測画面：経過時間と、顔が検出されているか（見る位置の目印の色で、実験者に控えめに知らせる）
setInterval(()=>{if(!state.recording||!state.session)return;const now=performance.now();
  $('overlayTime').textContent=`${((now-state.session.meta.start)/1000).toFixed(0)}秒`;
  const face=!!state.latest&&state.latest.faceDetected&&now-state.latest.processedAt<700;$('fixation').classList.toggle('lost',!face);},200);
// 記録中はズーム（ピンチ・ダブルタップ）と選択を止める（iOS Safari は viewport の指定だけでは止まらない）
for(const t of ['gesturestart','gesturechange','gestureend','dblclick','selectstart','contextmenu'])document.addEventListener(t,e=>{if(state.recording)e.preventDefault();},{passive:false});
function updateRecording(){
  if(!state.session)return;
  const seconds=((state.session.meta.end??performance.now())-state.session.meta.start)/1000;
  $('recordStatus').textContent=`${state.recording?'● 記録中':'記録停止'} ${seconds.toFixed(0)}秒 / 画像推定 ${state.session.frames.length}件 / IMU方向 ${state.session.orientation.length}件 / 動作 ${state.session.motion.length}件${state.storageOK?'':' ／ 自動退避できません。終了時に必ず保存してください。'}`;
  if(state.recording&&seconds>=1200){endRecord('20_minute_limit');status('20分で記録を停止しました。ファイルを保存してください。');}
}
setInterval(()=>{
  const now=performance.now();updateRecording();
  if(state.recording&&now-state.lastCheckpoint>=5000)checkpoint();
  if(state.running&&state.latest&&now-state.latest.processedAt>1500){
    clearValues();$('quality').textContent='映像の更新が止まっています。カメラの状態を確認してください。';
    $('baseline').disabled=true;$('calibrate').disabled=true;$('record').disabled=true;
  }
  if(state.running&&state.collect&&now-state.collect.start>6000){state.collect=null;status('顔推定のデータ不足で取得を中断しました。もう一度操作してください。',true);}
},1000);
function download(name,content,type){
  const url=URL.createObjectURL(new Blob([content],{type})),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
  status('保存操作を開始しました。iPhoneではダウンロード一覧／「ファイル」で保存先を確認してください。');
}
const csvCell=v=>`"${String(v??'').replaceAll('"','""')}"`;
function selectedSession(){return $('sessionSelect').value==='current'?state.session:state.archives.get($('sessionSelect').value);}
function refreshSessionSelect(){
  const previous=$('sessionSelect').value;
  $('sessionSelect').replaceChildren(new Option('現在の記録','current'));
  for(const [id,s] of [...state.archives].reverse()){
    if(id===state.session?.meta.id)continue;
    const when=new Date(s.meta.createdAt).toLocaleString('ja-JP');
    $('sessionSelect').add(new Option(`${when} / ${s.frames.length}件（退避済み）`,id));
  }
  if([...$('sessionSelect').options].some(o=>o.value===previous))$('sessionSelect').value=previous;
  $('sessionSelect').disabled=state.recording||state.recordStarting||(!state.session&&!state.archives.size);
}
function updateSaveStatus(){
  const s=selectedSession();
  if(!s){$('saveStatus').textContent='記録を停止した後にCSVと全記録JSONを保存できます。';return;}
  const out=s.meta.exports||{};
  $('saveStatus').textContent=`CSV：${out.csvRequestedAt?'保存操作済み':'未出力'} ／ 全記録JSON：${out.jsonRequestedAt?'保存操作済み':'未出力'}。保存完了は端末の「ファイル」等で確認してください。`;
}
async function archiveSession(s){
  const d=await db(),tx=d.transaction('archives','readwrite');
  const done=finishTransaction(tx);
  tx.objectStore('archives').put({id:s.meta.id,session:s});
  await done;state.archives.set(s.meta.id,s);refreshSessionSelect();
}
function exportRequested(s,format){
  s.meta.exports??={};s.meta.exports[`${format}RequestedAt`]=new Date().toISOString();
  if(s===state.session){if(format==='json'){state.dirty=false;dismissNextRecord();}checkpoint();}
  if(state.archives.has(s.meta.id))archiveSession(s).catch(()=>{});
  updateSaveStatus();
}
$('sessionSelect').addEventListener('change',()=>{
  const available=!!selectedSession()&&!state.recording;
  $('exportCsv').disabled=!available;$('exportJson').disabled=!available;updateSaveStatus();
});
$('exportCsv').addEventListener('click',()=>{
  const s=selectedSession();if(!s||state.recording)return;
  const keys=Object.keys(s.frames[0]||{}).filter(k=>k!=='matrix');
  const header=['sessionId','baselineIrisPx','baselineHeadInclination','calibrationDistanceCm',...keys];
  const rows=s.frames.map(r=>[s.meta.id,s.meta.baseline.irisPx,s.meta.baseline.head,s.meta.distanceCalibration?.knownDistanceCm,...keys.map(k=>r[k])]);
  download(`${s.meta.id}.csv`,'\ufeff'+[header,...rows].map(r=>r.map(csvCell).join(',')).join('\r\n'),'text/csv;charset=utf-8');
  exportRequested(s,'csv');
});
$('exportJson').addEventListener('click',()=>{const s=selectedSession();if(s&&!state.recording){download(`${s.meta.id}.json`,JSON.stringify(s),'application/json');exportRequested(s,'json');}});
async function readRecovery(){const d=await db();return new Promise((resolve,reject)=>{const r=d.transaction('chunks').objectStore('chunks').getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
let recovery=null;
readRecovery().then(chunks=>{if(chunks.length&&chunks[0].meta){recovery=chunks;$('recover').hidden=false;}}).catch(()=>{});
db().then(d=>new Promise((resolve,reject)=>{
  const r=d.transaction('archives').objectStore('archives').getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);
})).then(items=>{for(const item of items)if(!state.archives.has(item.id))state.archives.set(item.id,item.session);refreshSessionSelect();}).catch(()=>{});
function recoveredSession(){
  const result={meta:{...recovery[0].meta,recovered:true},frames:[],motion:[],orientation:[],events:[],inputs:[]};
  for(const c of recovery.slice(1))for(const k of ['frames','motion','orientation','events','inputs'])result[k].push(...(c[k]||[]));
  return result;
}
$('recover').addEventListener('click',()=>{
  if(!recovery)return;const result=recoveredSession();
  download(`${result.meta.id}-recovered.json`,JSON.stringify(result),'application/json');
});
window.addEventListener('beforeunload',e=>{if(state.dirty){e.preventDefault();e.returnValue='';}});
// ---- 0.4.0：合図待ち・音の合図・手動のカウントダウン・進行表で進める
function prepareAudio(){try{state.actx??=new (window.AudioContext||window.webkitAudioContext)();if(state.actx.state==='suspended')state.actx.resume();}catch{/* 音は任意 */}}
async function startMic(){
  if(state.mic)return state.mic;
  prepareAudio();const ctx=state.actx;if(!ctx)throw Error('音を扱えません');
  const stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false}});
  const src=ctx.createMediaStreamSource(stream),sink=ctx.createGain();sink.gain.value=0;sink.connect(ctx.destination);
  const det=new ToneDetector(ctx.sampleRate,{start:PP.TONES.start.map(x=>x[0]),end:PP.TONES.end.map(x=>x[0])});
  const onChunk=(samples,tEnd)=>{for(const h of det.push(samples,tEnd))onTone(h);};
  let node,mode;
  try{await ctx.audioWorklet.addModule('tone-worklet.js?v=0.4.0');node=new AudioWorkletNode(ctx,'tone-tap');mode='audioworklet';
    // 塊の最後の標本の時刻 ＝ いま −（音の時計の現在 − その標本の時刻）
    node.port.onmessage=e=>onChunk(e.data.samples,performance.now()-(ctx.currentTime-e.data.endFrame/ctx.sampleRate)*1000);}
  catch{node=ctx.createScriptProcessor(SYNC.toneSamples,1,1);mode='scriptprocessor';node.onaudioprocess=e=>onChunk(Float32Array.from(e.inputBuffer.getChannelData(0)),performance.now());}
  src.connect(node);node.connect(sink);
  const tr=stream.getAudioTracks()[0];
  state.mic={stream,src,node,sink,det,settings:{...tr.getSettings(),label:tr.label,sampleRate:ctx.sampleRate,mode}};
  event('mic_start',{settings:state.mic.settings});
  return state.mic;
}
function stopMic(){const m=state.mic;if(!m)return;state.mic=null;try{m.src.disconnect();m.node.disconnect();m.sink.disconnect();}catch{}m.stream.getTracks().forEach(t=>t.stop());}
function onTone(h){
  const w=state.waiting;
  (state.toneLog??=[]).push({...h,at:performance.now(),state:w?'waiting':state.recording?'recording':'idle'});
  if(w&&h.pattern==='start'&&w.method==='tone'&&!w.countdown){startFromSync('tone',h.onsetMs,{detection:h});return;}
  if(state.recording){
    if(h.pattern==='end')event('sync_tone_end',{t:h.onsetMs,detectedAt:h.detectedMs,lengths:h.lengths,gaps:h.gaps});
    else event('sync_tone_start_heard',{t:h.onsetMs,detectedAt:h.detectedMs,lengths:h.lengths,gaps:h.gaps});   // 手動で始めたあとに聞こえた開始の音など（時刻合わせの参考）
  }
}
const condText=s=>`${s.id||'（IDなし）'}・${{fixed:'固定',hand:'手持ち',practice:'練習'}[s.condition]||s.condition}・${s.run??'?'}回目`;
const fmtDur=sec=>`${Math.floor(sec/60)}分${String(Math.round(sec%60)).padStart(2,'0')}秒`;
function enterWaiting(){
  const kind=$('protocolKind').value,sch=PP.buildSchedule(kind),subj=subjectForm();
  state.waiting={kind,sch,method:$('startMethod').value,enteredAt:performance.now(),countdown:null,timers:[]};
  lockSettings(true);wake();
  $('waitCond').textContent=condText(subj);$('waitProto').textContent=`進行表 ${sch.protocolVersion}：${PP.NAMES[kind]}（全${fmtDur(sch.total)}）`;
  $('waitCount').hidden=true;$('waitOverlay').hidden=false;document.documentElement.classList.add('waiting');
  updateWaitUI();
  startMic().then(()=>updateWaitUI()).catch(e=>{state.micError=e.message||String(e);updateWaitUI();});
  state.waiting.timers.push(setInterval(updateWaitUI,250));
}
function updateWaitUI(){
  const w=state.waiting;if(!w)return;
  $('waitTone').classList.toggle('sel',w.method==='tone');$('waitManual').classList.toggle('sel',w.method==='manual');
  const lv=state.mic?.det.level,db=lv>0?20*Math.log10(lv):null;
  const meter=state.mic?`マイク入力 ${db===null?'—':db.toFixed(0)+' dB'}`:state.micError?`マイクを使えません（${state.micError}）`:'マイクを準備しています…';
  $('waitStatus').textContent=w.countdown?'カウントダウン中です。0 で CVAカメラの記録スタートを押してください。'
    :w.method==='tone'?(state.mic?`CVAカメラの開始の音を待っています（${meter}）。`:`${meter}。手動で開始してください。`)
    :`手動：下のボタンを2秒長押しすると、${SYNC.countdownSec}秒のカウントダウンが始まります（${meter}）。`;
}
function setWaitMethod(m){const w=state.waiting;if(!w||w.countdown)return;w.method=m;$('startMethod').value=m;updateWaitUI();}
function startCountdown(){
  const w=state.waiting;if(!w||w.countdown)return;
  w.method='manual';const tEnd=performance.now()+SYNC.countdownSec*1000;w.countdown={tEnd,startedAt:performance.now()};
  $('waitCount').hidden=false;let last=null;
  const tick=()=>{if(state.waiting!==w)return;const left=Math.ceil((tEnd-performance.now())/1000);
    if(left!==last&&left>0){last=left;$('waitCount').textContent=left;beep(1000,80,.2);}
    if(performance.now()>=tEnd-2){startFromSync('manual',tEnd,{countdownSec:SYNC.countdownSec});return;}
    w.timers.push(setTimeout(tick,Math.min(50,Math.max(0,tEnd-performance.now()))));};
  tick();updateWaitUI();
}
function clearWait(){const w=state.waiting;if(!w)return null;w.timers.forEach(id=>{clearTimeout(id);clearInterval(id);});state.waiting=null;$('waitOverlay').hidden=true;document.documentElement.classList.remove('waiting');return w;}
function cancelWaiting(reason='user'){const w=clearWait();if(!w)return;stopMic();lockSettings(false);status(reason==='page_hidden'?'画面が隠れたので、合図待ちをやめました。':'合図待ちをやめました。');refreshSessionSelect();}
function startFromSync(method,t0,detail){
  const w=clearWait();if(!w)return;
  if(method==='manual')beep(1600,250,.25);
  beginSession({method,t0,kind:w.kind,sch:w.sch,detail:{...detail,waitedSec:(performance.now()-w.enteredAt)/1000}});afterBegin();
  status(method==='tone'?'開始の音を聞きました。進行表で記録しています。':'カウントダウンで開始しました。進行表で記録しています。');
}
$('waitTone').addEventListener('click',()=>setWaitMethod('tone'));$('waitManual').addEventListener('click',()=>setWaitMethod('manual'));
$('waitCancel').addEventListener('click',()=>cancelWaiting());
longPress($('waitManualStart'),startCountdown);
$('protocolKind').addEventListener('change',updateRecordButton);
// 進行表の区間を進め、画面を切り替え、最後に自動で停止する
function setScreen(kind){state.screen=kind;$('recordOverlay').dataset.screen=kind;}
setInterval(()=>{
  const tt=state.recording?state.timetable:null;if(!tt)return;
  const sec=(performance.now()-tt.t0)/1000,at=PP.segmentAt(tt.sch,sec),key=at.seg?`${at.seg.index}:${at.phase}`:at.phase;
  if(key!==tt.lastKey){tt.lastKey=key;const g=at.seg;
    event('stage',{label:g?.label??null,stage:g?(g.nod?'nod':at.phase):(at.phase==='lead'?'prep':'done'),step:g?.step??null,index:g?.index??null,plannedSec:g?(at.phase==='hold'?g.holdStart:at.phase==='transition'?g.transStart:g.guideStart):null,sec});
  }
  // 読書の区間（hold）だけ文章を出す。区間の始まりに1ページ目、pageSec ごとに次のページへ（横にスライド）。文章の上のバーは次のページまでの残り時間
  const g=at.seg,reading=g&&g.screen==='reading'&&at.phase==='hold';
  if(reading){
    const ps=tt.sch.sec.readingPage,el=sec-g.holdStart,rt=tt.reading,page=Math.min(rt.pages.length-1,Math.floor(el/ps));
    if(state.screen!=='reading')setScreen('reading');
    if(page!==tt.page){tt.page=page;const t=$('readingText');t.textContent=rt.pages[page];$('readingPage').textContent=`${page+1} / ${rt.pages.length}`;
      t.classList.remove('slide');void t.offsetWidth;if(page>0)t.classList.add('slide');
      event('reading_page',{page,textId:rt.id,plannedSec:+(g.holdStart+page*ps).toFixed(3),sec,wallMs:Date.now()});}
    $('readingBar').style.width=`${Math.max(0,100*(1-(el-page*ps)/ps)).toFixed(1)}%`;
  }else if(state.screen!=='mark'){setScreen('mark');tt.page=null;$('readingText').textContent='';event('reading_end',{sec});}
  if(sec>=tt.sch.stopAt)endRecord('protocol_end');
},20);
window.__pl=state;   // 動作確認用
