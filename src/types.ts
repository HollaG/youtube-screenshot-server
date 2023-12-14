export interface CropSettings {
    [timestamp: number]: {
        left: number;
        leftOffset: number;
        bottom: number;
        bottomOffset: number;
    };
}
