import {rad,median,sd,mean,faceRotation,headInclination,measureIris} from './geometry.js';

const $=id=>document.getElementById(id), video=$('video'),canvas=$('overlay'),ctx=canvas.getContext('2d');
const MP_VERSION='1.0.1';
const APP_VERSION='0.1.1';
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
async function wake(){try{state.wake=await navigator.wakeLock?.request('screen');}catch{/* Optional feature. */}}

$('start').addEventListener('click',async()=>{
  if(state.running||state.starting)return;
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
    $('stop').disabled=false;$('retryImu').disabled=false;
    status('準備できました。縦持ちで顔を正面に向け、基準姿勢を記録してください。');
    track.addEventListener('ended',()=>{if(state.running){stop();status('カメラが切断されました。再度開始してください。',true);}});
    await wake();requestAnimationFrame(tick);
  }catch(e){stop();status(`開始できませんでした：${e.message}。カメラ許可・通信・HTTPS接続を確認してください。`,true);}
  finally{state.starting=false;$('start').disabled=state.running;}
});
$('retryImu').addEventListener('click',()=>{permissionsFromClick();});
$('stop').addEventListener('click',stop);
function stop(){
  dismissNextRecord();
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
    distanceMode:state.calibration?'one-point-calibrated':'assumed-fov',...cfg,matrix:pose?.matrix??null,matrixColumnMajor:pose?.columnMajor??null};
  state.latest=row;
  draw(result.landmarks);
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
  $('record').disabled=!state.baseline||state.recording||state.recordStarting||state.awaitingNext||!!state.collect;
  collectFrame(row);
}
function draw(lm){
  ctx.clearRect(0,0,canvas.width,canvas.height);
  if(!lm)return;
  ctx.strokeStyle='#70f0cf';ctx.lineWidth=Math.max(1,canvas.width/400);
  for(const indices of [[469,470,471,472],[474,475,476,477]]){ctx.beginPath();indices.forEach((i,j)=>{const p=lm[i];if(p)j?ctx.lineTo(p.x*canvas.width,p.y*canvas.height):ctx.moveTo(p.x*canvas.width,p.y*canvas.height);});ctx.closePath();ctx.stroke();}
  for(const i of [1,468,473])if(lm[i]){ctx.beginPath();ctx.arc(lm[i].x*canvas.width,lm[i].y*canvas.height,3,0,2*Math.PI);ctx.stroke();}
}
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
    state.baseline={t:performance.now(),irisPx,head,frames:rows.length,validImuFrames:heads.length,...config()};
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
  if(document.hidden){if(state.recording)endRecord('page_hidden');state.collect=null;clearValues();}
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
    const counts=Object.fromEntries(['frames','motion','orientation','events'].map(k=>[k,s[k].length]));
    const chunk={id:state.chunk};for(const k of Object.keys(counts))chunk[k]=s[k].slice(reset?0:state.saved[k],counts[k]);
    const tx=d.transaction('chunks','readwrite'),store=tx.objectStore('chunks');
    const done=finishTransaction(tx);
    if(reset)store.clear();
    store.put({id:0,meta:s.meta});store.put(chunk);
    await done;
    state.saved=counts;state.chunk++;state.storageOK=true;state.lastCheckpoint=performance.now();
  }catch{state.storageOK=false;}
  finally{state.saveBusy=false;}
}
function lockSettings(locked){for(const id of ['hfov','irisMm','knownDistance'])$(id).disabled=locked;}
$('record').addEventListener('click',()=>{
  if(state.recording||state.recordStarting||!state.running||!state.baseline)return;
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
  if(state.recording||state.recordStarting||!state.running||!state.baseline||state.collect)return;
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
    beginSession();
    // A checkpoint failure must not suspend live capture or leave the UI locked.
    checkpoint(true);updateRecording();status('新しい記録を開始しました。');
  }catch(e){status(`次の記録を開始できませんでした：${e.message} 前の記録は保持しています。CSV／JSONを保存できます。`,true);}
  finally{
    state.recordStarting=false;$('continueRecord').disabled=false;refreshSessionSelect();
    $('exportCsv').disabled=state.recording||!selectedSession();$('exportJson').disabled=state.recording||!selectedSession();
  }
}
function beginSession(){
  const id=`posture-${new Date().toISOString().replace(/[:.]/g,'-')}`;
  state.session={meta:{id,version:APP_VERSION,createdAt:new Date().toISOString(),exports:{},timeOrigin:performance.timeOrigin,start:performance.now(),browser:navigator.userAgent,mediapipeVersion:MP_VERSION,model:MODEL,settings:state.cameraSettings,inference:state.mode,config:config(),baseline:{...state.baseline},distanceCalibration:state.calibration?{...state.calibration}:null,
    units:{time:'milliseconds relative to performance.timeOrigin',videoTime:'seconds in video timeline; not hardware exposure timestamp',angles:'degrees',distance:'cm',iris:'source image px',acceleration:'m/s^2',rotationRate:'deg/s'},
    limitations:['unvalidated prototype','portrait front camera only','orientation matched by latest receive time, not hardware synchronization','provisional CVA model is not an observed anatomical CVA','iris distance does not separate phone motion from head motion'],qualityRules:{orientationMaxAgeMs:250,yawMaxDeg:25,pitchMaxDeg:40,rollMaxDeg:25,irisMinPx:5,minEyeAspectRatio:.12,minLeftRightRatio:.65}},frames:[],motion:[],orientation:[],events:[]};
  state.saved={frames:0,motion:0,orientation:0,events:0};state.chunk=1;
  state.recording=true;state.dirty=true;event('record_start');lockSettings(true);
  $('record').disabled=true;$('endRecord').disabled=false;
  $('exportCsv').disabled=true;$('exportJson').disabled=true;
  refreshSessionSelect();$('sessionSelect').value='current';$('sessionSelect').disabled=true;updateSaveStatus();
}
function endRecord(reason='user'){
  if(!state.recording)return;
  event('record_stop',{reason});state.recording=false;state.session.meta.end=performance.now();state.session.meta.stopReason=reason;
  lockSettings(false);$('endRecord').disabled=true;$('exportCsv').disabled=false;$('exportJson').disabled=false;
  refreshSessionSelect();updateSaveStatus();
  checkpoint();updateRecording();
}
$('endRecord').addEventListener('click',()=>endRecord());
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
  const result={meta:{...recovery[0].meta,recovered:true},frames:[],motion:[],orientation:[],events:[]};
  for(const c of recovery.slice(1))for(const k of ['frames','motion','orientation','events'])result[k].push(...(c[k]||[]));
  return result;
}
$('recover').addEventListener('click',()=>{
  if(!recovery)return;const result=recoveredSession();
  download(`${result.meta.id}-recovered.json`,JSON.stringify(result),'application/json');
});
window.addEventListener('beforeunload',e=>{if(state.dirty){e.preventDefault();e.returnValue='';}});
