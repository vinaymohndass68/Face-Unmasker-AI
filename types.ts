export enum AppState {
  IDLE,
  CAPTURING,
  CROPPING,
  GENERATING,
  RESULT_SHOWN,
  ERROR,
}

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
