export const rad = x => x*Math.PI/180;
export const deg = x => x*180/Math.PI;
export const clamp = (x,a,b) => Math.max(a,Math.min(b,x));
export const mean = a => a.reduce((s,x)=>s+x,0)/a.length;
export const median = a => { const b=[...a].sort((x,y)=>x-y);const n=b.length;return n ? (b[(n-1)>>1]+b[n>>1])/2 : null; };
export const sd = a => { const m=mean(a);return Math.sqrt(mean(a.map(x=>(x-m)**2))); };
const unit = v => {const n=Math.hypot(...v);return n>1e-8?v.map(x=>x/n):null;};

export function faceRotation(matrix) {
  if (!matrix || matrix.data?.length !== 16) return null;
  const m=Array.from(matrix.data);
  // Same layout check as the reference demo; retain the layout in exported data.
  const columnMajor=Math.abs(m[12])+Math.abs(m[13])+Math.abs(m[14])>=Math.abs(m[3])+Math.abs(m[7])+Math.abs(m[11]);
  const at=(i,j)=>columnMajor?m[4*j+i]:m[4*i+j];
  const cols=[0,1,2].map(j=>unit([at(0,j),at(1,j),at(2,j)]));
  if(cols.some(c=>!c))return null;
  const R=(i,j)=>cols[j][i];
  return {pitch:deg(Math.atan2(R(2,1),R(2,2))),yaw:-deg(Math.asin(clamp(-R(2,0),-1,1))),roll:deg(Math.atan2(R(1,0),R(0,0))),normal:cols[2],matrix:m,columnMajor};
}

// Portrait only. DeviceOrientation uses Rz(alpha) Rx(beta) Ry(gamma).
// Earth's up expressed in device axes is the third row of that rotation.
// Alpha is unnecessary for inclination relative to gravity.
export function upFromOrientation(o) {
  if(!o || !Number.isFinite(o.beta) || !Number.isFinite(o.gamma))return null;
  const b=rad(o.beta),g=rad(o.gamma);
  return [-Math.cos(b)*Math.sin(g),Math.sin(b),Math.cos(b)*Math.cos(g)];
}

export function headInclination(pose,o) {
  return headInclinationFromUp(pose,upFromOrientation(o));
}
// 端末座標で表した鉛直上向き up から h を求める（headInclination と同じ定義：下向きが正、重力基準）
export function headInclinationFromUp(pose,up) {
  if(!pose||!up)return null;
  // Unmirrored front-camera geometry -> device axes: rotate 180° about y.
  // CSS mirror affects display only. Actual device axis correspondence needs
  // physical validation; never infer neck translation or CVA from this alone.
  const n=pose.normal;const forward=[-n[0],n[1],-n[2]];
  return -deg(Math.asin(clamp(forward.reduce((s,x,i)=>s+x*up[i],0),-1,1)));
}

// devicemotion の accelerationIncludingGravity（静止時は重力の反力＝上向き）から端末座標の上向きを求める。
// 端末によって符号が逆のことがあるので、sign（+1 / −1）を掛けて使う。手の動きの加速度も含むので、呼び出し側で平滑化する
export function upFromGravity(g,sign=1) {
  if(!g||![g.x,g.y,g.z].every(Number.isFinite))return null;
  const v=unit([g.x*sign,g.y*sign,g.z*sign]);
  return v;
}
export const IRIS_POINTS=[468,469,470,471,472,473,474,475,476,477];
export const EYELID_POINTS={right:[159,145,33,133],left:[386,374,362,263]};   // [上まぶた, 下まぶた, 目尻, 目頭]
export function measureIris(lm,w,h) {
  if(!lm||lm.length<478)return null;
  const px=i=>[lm[i].x*w,lm[i].y*h];
  const dist=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
  const diameter=c=>Math.max(dist(px(c+1),px(c+3)),dist(px(c+2),px(c+4)));
  const right=diameter(468),left=diameter(473),p=(right+left)/2;
  const center=[(lm[468].x+lm[473].x)/2,(lm[468].y+lm[473].y)/2];
  const eyeOpen=(a,b,c,d)=>dist(px(a),px(b))/Math.max(1,dist(px(c),px(d)));
  const openRight=eyeOpen(...EYELID_POINTS.right),openLeft=eyeOpen(...EYELID_POINTS.left);
  const open=Math.min(openRight,openLeft);
  const inFrame=IRIS_POINTS.every(i=>lm[i].x>0&&lm[i].x<1&&lm[i].y>0&&lm[i].y<1);
  const valid=Number.isFinite(p)&&p>=5&&Math.min(left,right)/Math.max(left,right)>.65&&open>.12&&inFrame;
  // 記録用（0.2.0）：目ごとの横径・縦径（x方向の成分が大きい方の組を横径とする）、まぶたの開き、無効の理由
  const hv=c=>{const a=px(c+1),b=px(c+3),d=px(c+2),e=px(c+4),first=Math.abs(a[0]-b[0])>=Math.abs(d[0]-e[0]);
    return first?{h:dist(a,b),v:dist(d,e)}:{h:dist(d,e),v:dist(a,b)};};
  const reasons=[];
  if(!(Number.isFinite(p)&&p>=5))reasons.push('iris_small');
  if(!(Math.min(left,right)/Math.max(left,right)>.65))reasons.push('iris_lr_mismatch');
  if(!(open>.12))reasons.push('eye_closed');
  if(!inFrame)reasons.push('iris_out_of_frame');
  return {left,right,p,center,open,valid,openRight,openLeft,rightHV:hv(468),leftHV:hv(473),reasons,
    points:Object.fromEntries(IRIS_POINTS.map(i=>[i,px(i)])),
    eyelidGapPx:{right:dist(px(159),px(145)),left:dist(px(386),px(374))}};
}
