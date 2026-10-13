export type ImageQualityMetrics = {
  width: number;
  height: number;
  laplacianVariance: number;
  grayscaleStdDev: number;
};

export type ImageQualityResult = {
  pass: boolean;
  level: "ok" | "warning" | "block";
  message: string;
  quality: ImageQualityMetrics;
};

const MIN_WIDTH = 1024;
const MIN_HEIGHT = 768;
const BLUR_VARIANCE_BLOCK = 50;
const BLUR_VARIANCE_WARNING = 100;
const UNIFORM_STDDEV_BLOCK = 12;
const DOWNSAMPLE_MAX_W = 256;

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Kunne ikke lese bildefil."));
    };
    img.src = url;
  });
}

function downsampleToGrayscale(
  img: HTMLImageElement,
  maxW: number,
): { canvas: HTMLCanvasElement; gray: Uint8ClampedArray; w: number; h: number } {
  const ratio = img.width / img.height;
  const w = Math.min(maxW, img.width);
  const h = Math.round(w / ratio);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Fant ikke canvas context.");
  ctx.drawImage(img, 0, 0, w, h);
  const imgData = ctx.getImageData(0, 0, w, h);
  const data = imgData.data;
  const gray = new Uint8ClampedArray(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = data[i * 4]!;
    const g = data[i * 4 + 1]!;
    const b = data[i * 4 + 2]!;
    gray[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  }
  return { canvas, gray, w, h };
}

function laplacianVariance(gray: Uint8ClampedArray, w: number, h: number): number {
  const KERNEL = [
    [0, 1, 0],
    [1, -4, 1],
    [0, 1, 0],
  ] as const;
  const result: number[] = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      let v = 0;
      for (let ky = -1; ky <= 1; ky++) {
        for (let kx = -1; kx <= 1; kx++) {
          const px = x + kx;
          const py = y + ky;
          v += gray[py * w + px]! * KERNEL[ky + 1]![kx + 1]!;
        }
      }
      result.push(v);
    }
  }
  if (result.length === 0) return 0;
  const mean = result.reduce((a, b) => a + b, 0) / result.length;
  const variance =
    result.reduce((acc, v) => acc + (v - mean) * (v - mean), 0) / result.length;
  return variance;
}

function grayscaleStdDev(gray: Uint8ClampedArray): number {
  if (gray.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < gray.length; i++) sum += gray[i]!;
  const mean = sum / gray.length;
  let sqSum = 0;
  for (let i = 0; i < gray.length; i++) {
    const d = gray[i]! - mean;
    sqSum += d * d;
  }
  return Math.sqrt(sqSum / gray.length);
}

export async function validateImageQuality(file: File): Promise<ImageQualityResult> {
  const img = await loadImage(file);
  try {
    const width = img.width;
    const height = img.height;

    if (width < MIN_WIDTH || height < MIN_HEIGHT) {
      return {
        pass: false,
        level: "block",
        message: `Bildet er for lite (${width}×${height} px). Minimum ${MIN_WIDTH}×${MIN_HEIGHT} px. Ta et nytt, større bilde.`,
        quality: { width, height, laplacianVariance: 0, grayscaleStdDev: 0 },
      };
    }

    const { gray, w, h } = downsampleToGrayscale(img, DOWNSAMPLE_MAX_W);
    const variance = laplacianVariance(gray, w, h);
    const stddev = grayscaleStdDev(gray);

    if (stddev < UNIFORM_STDDEV_BLOCK) {
      return {
        pass: false,
        level: "block",
        message:
          "Ingen bilde innhold funnet (for jevnt lys/mønster). Sannsynligvis finger foran linsen eller tomt område. Ta et nytt bilde.",
        quality: { width, height, laplacianVariance: variance, grayscaleStdDev: stddev },
      };
    }

    if (variance < BLUR_VARIANCE_BLOCK) {
      return {
        pass: false,
        level: "block",
        message:
          "Bildet er for uskarpt (utenfor fokus eller uskarp). Ta et nytt bilde med bedre fokus for nøyaktige resultater.",
        quality: { width, height, laplacianVariance: variance, grayscaleStdDev: stddev },
      };
    }

    if (variance < BLUR_VARIANCE_WARNING) {
      return {
        pass: true,
        level: "warning",
        message:
          "Bildet er litt uskarpt. Vi anbefaler at du tar et nytt bilde for bedre nøyaktighet, men du kan også sende dette likevel.",
        quality: { width, height, laplacianVariance: variance, grayscaleStdDev: stddev },
      };
    }

    return {
      pass: true,
      level: "ok",
      message: "Bilde kvalitet er bra.",
      quality: { width, height, laplacianVariance: variance, grayscaleStdDev: stddev },
    };
  } finally {
    if (img.src.startsWith("blob:")) {
      try {
        URL.revokeObjectURL(img.src);
      } catch {
        // ignore
      }
    }
  }
}
