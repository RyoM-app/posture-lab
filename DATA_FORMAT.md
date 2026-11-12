# posture-lab の記録の形式（0.2.0）

対象：posture-lab 0.2.0（2026-11-13）。旧形式は 0.1.1（dual_test1・2）。
**0.1.1 の列・キーは1つも消していません。** 0.2.0 で増えたものだけを、下に「追加」として書きます。

## ファイル

| ファイル | 中身 |
|---|---|
| `P01_fixed1_posture_<時刻>.json` | 全記録：`meta`、`frames`（画像1枚ごと）、`orientation`・`motion`（IMUのイベントごと）、`events` |
| `P01_fixed1_posture_<時刻>.csv` | `frames` の表（`matrix` 以外の列）。先頭に `sessionId` `baselineIrisPx` `baselineHeadInclination` `calibrationDistanceCm` |
| `camera-calibration-<時刻>.json` | カメラ校正の結果（任意で書き出す。同じ内容が記録の `meta.cameraCalibration` にも入る。ただし角の座標 `views` は記録には入れない） |

- `<時刻>` は記録開始の ISO 時刻の `:` と `.` を `-` に置き換えたもの
- 被験者IDなどを入れずに記録した場合だけ、旧形式と同じ `posture-<時刻>` になる
- 条件は `fixed`（固定）・`hand`（手持ち）・`practice`（練習）。ファイル名は「条件＋回番号」（例 `fixed1`、`hand1`）

## 時刻

- `frames[].t`、`orientation[].t`、`motion[].t`、`events[].t`、`meta.start`、`meta.end` は `performance.now()`（ms）
- Unix時刻は `meta.timeOrigin + t`（0.1.1 と同じ。CVAカメラの `epoch_ms` と同じ基準）
- **追加** `meta.clock = {dateNowMs, perfNowMs, timeOrigin}`：記録開始時の `Date.now()` と `performance.now()` の組。CVAカメラにも同じ組があるので、2台の時計のずれ（`timeOrigin` の誤差を含む）を見積もれる

## meta（追加）

| キー | 中身 |
|---|---|
| `subject` | `{id, condition, run, memo}`。例 `{"id":"P01","condition":"fixed","run":1,"memo":""}` |
| `clock` | 上記 |
| `holdMode` | `stand`（固定）／`hand`（手持ち）。条件を選ぶと自動で合わせる（練習は選んだまま） |
| `setup` | 基準を記録した3秒間の中央値：`mode`、`targetCm`（目標距離）、`passedAtStart`（3項目とも合格していたか）、`tiltLRDeg`・`tiltFBDeg`（端末の傾き）、`heightOffsetCm`（目の中点の主点からの上下のずれ。＋は目が下＝カメラが高い）、`distanceCm`（f×11.7 mm÷虹彩径）、`focalPx`、`focalSource`、`irisMmAssumed`（11.7）、`tolerances` |
| `focal` | `{focalPx, source, resolutionMismatch}`。`source` は `charuco`（カメラ校正）か `assumed-hfov`（仮の画角）。校正の解像度が違うと `resolutionMismatch: true` で仮の画角を使う |
| `cameraCalibration` | カメラ校正の結果（なければ `null`）。`focalPx`、`rmsPx`（再投影誤差）、`width`・`height`、`method`、`opencvVersion`、`board`（4×5、DICT_4X4_50、0.8、白黒反転、`squareMm`、`legacyPatternUsed`）、`frames`、`corners`、`opencv`（OpenCV.js の結果）、`own`（自前の最小二乗の結果）、`ownMinusOpencvPercent`、`hfovDeg`、`createdAt` |
| `quality` | 終了時の品質判定（下の「品質判定」） |
| `baseline.up` | 基準を記録した3秒間の、端末座標で表した鉛直上向き（単位ベクトル、中央値）。固定のときの `headInclinationFixedUp` とスタンドの動きの判定に使う |
| `baseline.setup` | `meta.setup` と同じ |

## frames（追加の列）

### f を使った値（カメラ校正）

| 列 | 中身 |
|---|---|
| `focalPx`、`focalSource` | そのフレームで使った f と出どころ（`charuco` / `assumed-hfov`） |
| `zFocalCm` | Z = f × 11.7 mm ÷ `irisPx` ÷ 10（cm）。虹彩の実寸は11.7 mmと仮定。**`irisValid` に関係なく、虹彩径が出れば計算する**（判定は解析で） |
| `eyeOffsetXPx`、`eyeOffsetYPx` | 両目の虹彩中心の中点の、画像の中心（主点）からのずれ（元画像の画素、左右反転なし。x：画像の右が＋＝本人の左、y：下が＋） |
| `eyeOffsetXCm`、`eyeOffsetYCm` | 上のずれを cm に：画素 × `zFocalCm` ÷ `focalPx` |
| `distanceCm` | 0.1.1 と同じ（1点校正、または仮の画角と `irisMm`）。残してある |

### IMU の2つの経路と h

| 列 | 中身 |
|---|---|
| `headInclination` | **0.1.1 と同じ**。顔が有効（`faceValid`）で、方向（deviceorientation）が250 ms以内のときだけ |
| `headInclinationRaw` | 顔の向きの有効範囲（yaw/pitch/roll）に関係なく計算した h。方向の値があればそれを、なければ加速度の値を使う（`imuSource`）。縦向きで、顔が検出されていることが条件 |
| `headInclinationOrientation` | 方向（deviceorientation）の上向きから求めた h |
| `headInclinationMotion` | 加速度（devicemotion の accelerationIncludingGravity を指数平滑したもの）の上向きから求めた h |
| `headInclinationFixedUp` | **固定（stand）のときだけ**。基準時の上向き `meta.baseline.up` で求めた h。IMU が途切れても出る（端末が動かない前提） |
| `imuSource` | `orientation` / `motion` / 空（どちらも古い） |
| `motionAgeMs` | 加速度のイベントの古さ（ms）。`imuAgeMs` は方向の古さ（0.1.1 と同じ） |
| `gravitySign`、`gravitySignSource` | 加速度の符号（端末によって逆）。`orientation`（方向と比べて決めた）か `portrait-assumption`（縦向き・上が上と仮定して決めた） |
| `gravityLPx`〜`gravityLPz` | 平滑化した重力成分（m/s²、符号はそのまま） |
| `upX`、`upY`、`upZ` | 使った上向き（端末座標の単位ベクトル。縦向きで垂直なら (0, 1, 0)） |
| `deviceTiltLRDeg`、`deviceTiltFBDeg` | 端末の傾き：左右 = atan2(u_x, u_y)（＋は上端が左、画面を見て）、前後 = atan2(u_z, u_y)（＋は画面が上を向く） |
| `standTiltChangeDeg` | 固定のとき：いまの上向きと `meta.baseline.up` のなす角（°） |

h の定義はどの列も同じ：未反転の前面カメラの顔正面ベクトル n を端末座標へ (−n_x, n_y, −n_z) と移し、h = −asin(n_device · u)。下向きが正、重力基準。方向の経路は u = (−cos β sin γ, sin β, cos β cos γ)、加速度の経路は u = 平滑化した重力成分 × 符号 ÷ 大きさ。

### 無効の理由・虹彩とまぶた

| 列 | 中身 |
|---|---|
| `invalidReasons` | `|` 区切り：`no_face`、`yaw`、`pitch`、`roll`（有効範囲 ±25/±40/±25°の外）、`landscape`、`no_iris`、`iris_small`（5 px未満）、`iris_lr_mismatch`（左右比0.65以下）、`eye_closed`（開き0.12以下）、`iris_out_of_frame`、`orientation_stale`・`orientation_missing`、`motion_stale`・`motion_missing`。空なら問題なし |
| `irisRightHPx`、`irisRightVPx`、`irisLeftHPx`、`irisLeftVPx` | 目ごとの虹彩の横径・縦径（外周4点の2本の直径のうち、x方向の成分が大きい方を横径）。`irisRightPx` などは従来どおり大きい方 |
| `eyeOpenRight`、`eyeOpenLeft`、`eyeOpenMin` | まぶたの開き＝上下まぶたの距離 ÷ 目の幅。右目 159–145 ÷ 33–133、左目 386–374 ÷ 362–263。`eyeOpenMin` が 0.12 以下だと `eye_closed` |
| `eyelidGapRightPx`、`eyelidGapLeftPx` | 上下まぶたの距離（px） |
| `iris468X`〜`iris477Y` | 虹彩の10点（468・473 が中心、469–472・474–477 が外周）の座標（元画像の画素）。右目＝468–472（本人の右） |

「目線だけ下げる」で、まぶたが虹彩を隠すと縦径（`…VPx`）が先に小さくなり、`eyeOpen…` も下がるはずです。

## events（追加）

| type | 中身 |
|---|---|
| `stand_moved` | 固定の記録中に、端末の傾きが基準から1°を超えた。`angleDeg`、`source` |
| `stand_returned` | 0.5°未満に戻った |

## motion（追加）

`motion[].gravityLP`：その時点の平滑化した重力成分。

## 品質判定（meta.quality）

区間を知らないので、資料の除外基準（区間ごとに70%）の代わりに次で判定する。正式な除外は解析で行う。

| 判定 | しきい値（`app.js` 冒頭の `QUALITY`） |
|---|---|
| 5秒窓（0.5秒ずつずらす）のうち最も悪い窓の「h が出たフレーム」の割合 | 70%未満でやり直し推奨 |
| h が出ない時間の最長（記録の始まり・終わりを含む） | 2秒以上でやり直し推奨 |
| 固定でスタンドが動いた（`stand_moved`） | 1回でもあればやり直し推奨 |

「h が出た」は、手持ちでは `headInclinationRaw` が出たフレーム、固定では `headInclinationRaw` か `headInclinationFixedUp` が出たフレーム（顔の向きの有効範囲では判定しない）。

`meta.quality` のキー：`ok`、`verdict`（`OK`／`やり直し推奨`）、`reasons`、`rules`、`durationSec`、`frames`、`fps`、`faceValidRate`、`irisValidRate`、`imuValidRate`（方向が有効）、`imuAnyRate`（どちらかの経路が有効）、`hRate`、`hRawRate`、`headInclinationRate`、`worstWindow {rate, startSec, frames}`、`longestHGap {sec, startSec}`、`imuGaps {orientation, motion: {count, maxMs}}`（250 ms超の途切れの回数と最長）、`standMoved {events, maxDeg}`。

## 解析で気をつけること

- **IMU の途切れ**：予備実験（dual_test1・2、iPhone の Chrome）では、方向と加速度が**同じ時刻に同じ長さだけ**止まっていた（1回目22回・最長5.0秒、2回目6回・最長3.4秒）。イベント自体の時刻（`eventTimestamp`）も同じだけ空いていたので、イベントが発生していなかった。カメラのフレームは途切れていない。したがって、加速度の予備の経路ではこの途切れは埋まらない。固定では `headInclinationFixedUp` を使える
- 傾けた直後は、加速度の平滑化（約80 ms）のぶん、`headInclinationMotion` が方向の値より遅れる（疑似データで2°傾けた直後に最大0.8°の差）
- `zFocalCm` は虹彩の実寸を11.7 mmと仮定した値。ΔCVA に使うのは主に変化量なので、個人差（約±4〜5%）の影響は小さい
- 列の数が増えたので、CSV よりも JSON を読むほうが確実（`matrix` も入っている）
