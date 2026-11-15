// カメラ校正（ChArUco、OpenCV.js）。校正画面を開いたときだけ読み込む。
// 推定するのは焦点距離 f（画素）だけ：主点＝画像の中心、fx＝fy、ゆがみ0 に固定する（角が12個と少ないため）。
import { estimateFocal, viewPose, rotationAngleDeg } from './calib-math.js';

export const OPENCV_VERSION = '4.12.0-release.1';
export const OPENCV_URL = `https://cdn.jsdelivr.net/npm/@techstark/opencv-js@${OPENCV_VERSION}/dist/opencv.js`;
// ~/Blender/mocap/scripts/cloud_calib/calib.py と同じ指定（charuco.toml：legacy_pattern = false）
// 0.3.2：ボードを作り直した（charuco_A4_4x5_4.8cm.pdf：白黒反転なし、マス48 mm＝4マスで192 mm）。inverted は印刷したボードの記録用
export const BOARD = { columns: 4, rows: 5, dictionary: 'DICT_4X4_50', markerScale: 0.8, inverted: false, legacyPattern: false };
export const DEFAULT_SQUARE_MM = 48;
export const CALIB_RULES = {
  targetFrames: 15,        // この枚数を集めたら計算する
  minCorners: 8,           // 採用するフレームに必要な角の数（12個中）
  minTiltDeg: 8,           // ボードがカメラに対してこれ以上傾いているフレームだけ採用（正面向きは f の情報が少ない）
  minRotationDiffDeg: 10,  // 採用済みのどのフレームとも、向きがこれ以上違う…
  minTranslationDiff: 0.15,//   …または位置が距離のこの割合以上違う
  passRmsPx: 1,            // 再投影誤差がこれ未満なら合格
  intervalMs: 200,         // 検出の間隔
};

let loading = null;
// 返り値は { cv }。OpenCV.js のモジュールは自分自身に then を持つので、そのまま resolve すると待ち続けてしまう
export function loadOpenCV(timeoutMs = 90000) {
  return loading ??= new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('OpenCV.js の読み込みがタイムアウトしました')), timeoutMs);
    const s = document.createElement('script');
    s.src = OPENCV_URL; s.async = true;
    s.onerror = () => { clearTimeout(timer); reject(Error('OpenCV.js を読み込めません（通信を確認してください）')); };
    s.onload = async () => {
      try {
        let cv = window.cv;
        if (cv instanceof Promise) cv = await cv;
        else if (!cv.Mat) await new Promise(r => { cv.onRuntimeInitialized = r; });
        clearTimeout(timer); resolve({ cv });
      } catch (e) { clearTimeout(timer); reject(e); }
    };
    document.head.append(s);
  }).catch(e => { loading = null; throw e; });
}

const cvMessage = (cv, e) => { try { return typeof e === 'number' ? cv.exceptionFromPtr(e).msg : String(e?.message || e); } catch { return String(e); } };

export class CharucoCalibrator {
  constructor(cv, { squareMm, width, height, fGuess }) {
    this.cv = cv; this.squareMm = squareMm; this.width = width; this.height = height; this.fGuess = fGuess;
    this.views = []; this.poses = []; this.legacy = BOARD.legacyPattern; this.legacyTried = false;
    this.dict = cv.getPredefinedDictionary(cv.DICT_4X4_50);
    this.makeDetector(this.legacy);
  }
  makeDetector(legacy) {
    const cv = this.cv;
    this.board?.delete(); this.detector?.delete();
    this.board = new cv.aruco_CharucoBoard(new cv.Size(BOARD.columns, BOARD.rows), this.squareMm, this.squareMm * BOARD.markerScale, this.dict, new cv.Mat());
    this.board.setLegacyPattern(legacy);
    const dp = new cv.aruco_DetectorParameters();
    dp.detectInvertedMarker = true;   // 通常のマーカーを探し、見つからなければ白黒反転も試す（新しいボードも、以前の反転したボードも使える）
    this.detector = new cv.aruco_CharucoDetector(this.board, new cv.aruco_CharucoParameters(), dp, new cv.aruco_RefineParameters(10, 3, true));
    // 角の番号 → ボード上の座標（mm）。OpenCV.js の Point3f は z を返さないので 0 にする（平面）
    const chess = this.board.getChessboardCorners();
    this.cornerXY = [];
    for (let k = 0; k < chess.size(); k++) { const q = chess.get(k); this.cornerXY.push([q.x, q.y]); }
  }
  detectOnce(gray) {
    const cv = this.cv, cc = new cv.Mat(), ci = new cv.Mat(), mc = new cv.MatVector(), mi = new cv.Mat();
    try {
      this.detector.detectBoard(gray, cc, ci, mc, mi);
      const ids = Array.from(ci.data32S), xy = Array.from(cc.data32F), img = ids.map((_, k) => [xy[2 * k], xy[2 * k + 1]]);
      return { ids, img, markers: mi.rows };
    } finally { cc.delete(); ci.delete(); mc.delete(); mi.delete(); }
  }
  // 1フレームを処理。ImageData を受け取り、検出結果と採用したかどうかを返す
  process(imageData) {
    const cv = this.cv, rgba = cv.matFromImageData(imageData), gray = new cv.Mat();
    try {
      cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
      let det = this.detectOnce(gray);
      // マーカーは見えるのに角が出ないときは、OpenCV の版による模様の違い（legacy pattern）を1度だけ試す
      if (det.markers >= 4 && det.ids.length < 4 && !this.legacyTried) {
        this.legacyTried = true;
        this.makeDetector(!this.legacy);
        const alt = this.detectOnce(gray);
        if (alt.ids.length > det.ids.length) { this.legacy = !this.legacy; det = alt; }
        else this.makeDetector(this.legacy);
      }
      return { ...det, ...this.consider(det) };
    } finally { rgba.delete(); gray.delete(); }
  }
  consider(det) {
    if (det.ids.length < CALIB_RULES.minCorners) return { accepted: false, reason: det.ids.length ? `角が${det.ids.length}個（${CALIB_RULES.minCorners}個以上必要）` : 'ボードが見えません' };
    if (this.views.length >= CALIB_RULES.targetFrames) return { accepted: false, reason: '必要な枚数が集まりました' };
    const obj = det.ids.map(id => this.cornerXY[id]);
    const pose = viewPose(obj, det.img, this.fGuess, this.width, this.height);
    if (pose.tiltDeg < CALIB_RULES.minTiltDeg) return { accepted: false, reason: 'ボードを少し斜めに傾けてください', tiltDeg: pose.tiltDeg };
    const dist = Math.hypot(...pose.t);
    const similar = this.poses.some(q => rotationAngleDeg(q.R, pose.R) < CALIB_RULES.minRotationDiffDeg && Math.hypot(...pose.t.map((x, i) => x - q.t[i])) < CALIB_RULES.minTranslationDiff * dist);
    if (similar) return { accepted: false, reason: '前に採用した向き・位置と似ています。ボードを動かしてください', tiltDeg: pose.tiltDeg };
    this.views.push({ obj, img: det.img, ids: det.ids }); this.poses.push(pose);
    return { accepted: true, tiltDeg: pose.tiltDeg };
  }
  // 15枚そろったら計算。OpenCV.js の calibrateCameraExtended と、自前の最小二乗の両方で求めて比べる
  compute() {
    const cv = this.cv, own = estimateFocal(this.views, this.width, this.height);
    let opencv = null, error = null;
    const objs = new cv.MatVector(), imgs = new cv.MatVector(), mats = [];
    try {
      for (const v of this.views) {
        const o = cv.matFromArray(v.obj.length, 1, cv.CV_32FC3, v.obj.flatMap(p => [p[0], p[1], 0]));
        const i = cv.matFromArray(v.img.length, 1, cv.CV_32FC2, v.img.flat());
        objs.push_back(o); imgs.push_back(i); mats.push(o, i);
      }
      const f0 = own?.f ?? this.fGuess;
      const K = cv.matFromArray(3, 3, cv.CV_64F, [f0, 0, this.width / 2, 0, f0, this.height / 2, 0, 0, 1]);
      const D = cv.Mat.zeros(1, 5, cv.CV_64F), rv = new cv.MatVector(), tv = new cv.MatVector(), s1 = new cv.Mat(), s2 = new cv.Mat(), pe = new cv.Mat();
      mats.push(K, D, rv, tv, s1, s2, pe);
      const flags = cv.CALIB_USE_INTRINSIC_GUESS | cv.CALIB_FIX_PRINCIPAL_POINT | cv.CALIB_FIX_ASPECT_RATIO | cv.CALIB_ZERO_TANGENT_DIST | cv.CALIB_FIX_K1 | cv.CALIB_FIX_K2 | cv.CALIB_FIX_K3;
      const rms = cv.calibrateCameraExtended(objs, imgs, new cv.Size(this.width, this.height), K, D, rv, tv, s1, s2, pe, flags, new cv.TermCriteria(cv.TermCriteria_COUNT + cv.TermCriteria_EPS, 100, 1e-9));
      opencv = { f: K.doubleAt(0, 0), fy: K.doubleAt(1, 1), rms, fStdDevPx: s1.rows ? s1.doubleAt(0, 0) : null, perViewErrorsPx: Array.from(pe.data64F) };
    } catch (e) { error = cvMessage(cv, e); }
    finally { mats.forEach(m => m.delete()); objs.delete(); imgs.delete(); }
    const main = opencv ?? (own ? { f: own.f, rms: own.rms } : null);
    if (!main) return { ok: false, error: error || '計算できませんでした' };
    return {
      ok: main.rms < CALIB_RULES.passRmsPx,
      method: opencv ? 'opencv.js calibrateCameraExtended' : 'own least squares (OpenCV.js failed)',
      focalPx: main.f, rmsPx: main.rms,
      opencv, own, opencvError: error,
      ownMinusOpencvPercent: opencv && own ? (own.f - opencv.f) / opencv.f * 100 : null,
      frames: this.views.length, corners: this.views.reduce((s, v) => s + v.ids.length, 0),
      legacyPattern: this.legacy,
    };
  }
  dispose() { this.board?.delete(); this.detector?.delete(); this.dict?.delete?.(); }
}
