// A single frame is in flight. Never queue frames behind a slow inference.
const VERSION = "1.0.1";
const BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}`;
const MODEL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
let detector;
self.onmessage = async ({data}) => {
  if (data.type === "init") {
    try {
      const {FaceLandmarker, FilesetResolver} = await import(`${BASE}/vision_bundle.mjs`);
      const files = await FilesetResolver.forVisionTasks(`${BASE}/wasm`);
      let delegate = "GPU";
      const options = d => ({baseOptions:{modelAssetPath:MODEL,delegate:d},runningMode:"VIDEO",numFaces:1,outputFacialTransformationMatrixes:true});
      try { detector = await FaceLandmarker.createFromOptions(files, options(delegate)); }
      catch { delegate = "CPU"; detector = await FaceLandmarker.createFromOptions(files, options(delegate)); }
      self.postMessage({type:"ready",delegate});
    } catch (e) { self.postMessage({type:"error",message:String(e.message || e)}); }
    return;
  }
  if (data.type === "frame") {
    const start = performance.now();
    try {
      const result = detector.detectForVideo(data.image, data.t);
      self.postMessage({type:"result",id:data.id,landmarks:result.faceLandmarks[0] || null,matrix:result.facialTransformationMatrixes[0] || null,inferenceMs:performance.now()-start});
    } catch (e) { self.postMessage({type:"frame-error",id:data.id,message:String(e.message || e)}); }
    finally { data.image.close(); }
  }
};
