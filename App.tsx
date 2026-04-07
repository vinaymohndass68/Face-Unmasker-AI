import React, { useState, useRef, useCallback, useEffect } from 'react';
import { AppState, CropRect } from './types';
import { UploadIcon, CameraIcon, MagicWandIcon, ResetIcon, BackIcon, DownloadIcon } from './components/icons';
import { removeMask, editImage } from './services/geminiService';

// --- HELPER FUNCTIONS ---

const blobToBase64 = (blob: Blob): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
};

const stitchImages = (
  originalUrl: string,
  generatedCropUrl: string,
  cropRect: CropRect,
  displaySize: { width: number; height: number }
): Promise<string> => {
  return new Promise((resolve, reject) => {
    const originalImage = new Image();
    const generatedCropImage = new Image();
    originalImage.crossOrigin = "anonymous";
    generatedCropImage.crossOrigin = "anonymous";

    let originalLoaded = false;
    let cropLoaded = false;

    const onImagesLoaded = () => {
      if (!originalLoaded || !cropLoaded) return;

      // Main canvas for the final image
      const canvas = document.createElement('canvas');
      canvas.width = originalImage.naturalWidth;
      canvas.height = originalImage.naturalHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        return reject(new Error("Could not get canvas context"));
      }

      // 1. Draw original image onto the main canvas
      ctx.drawImage(originalImage, 0, 0);
      
      const scaleX = originalImage.naturalWidth / displaySize.width;
      const scaleY = originalImage.naturalHeight / displaySize.height;

      const destX = cropRect.x * scaleX;
      const destY = cropRect.y * scaleY;
      const destWidth = cropRect.width * scaleX;
      const destHeight = cropRect.height * scaleY;

      // Create a temporary canvas for the generated crop to apply a feathering mask
      const cropCanvas = document.createElement('canvas');
      cropCanvas.width = destWidth;
      cropCanvas.height = destHeight;
      const cropCtx = cropCanvas.getContext('2d');
      if (!cropCtx) {
        return reject(new Error("Could not get crop canvas context"));
      }

      // 2. Draw the generated (unmasked) crop onto its own canvas
      cropCtx.drawImage(generatedCropImage, 0, 0, destWidth, destHeight);

      // 3. Apply a feathering mask to the crop canvas. This will make the edges transparent,
      // creating a soft blend instead of a hard rectangle.
      cropCtx.globalCompositeOperation = 'destination-in';
      
      const radius = Math.min(destWidth, destHeight) / 2;
      const featherWidth = radius * 0.5; // Feathering is 50% of the radius for a soft blend

      // Create a circular gradient that is opaque in the center and fades to transparent.
      // This is ideal for blending faces.
      const gradient = cropCtx.createRadialGradient(
        destWidth / 2, destHeight / 2, radius - featherWidth, // Inner circle (fully opaque)
        destWidth / 2, destHeight / 2, radius // Outer circle (fully transparent)
      );
      
      gradient.addColorStop(0, 'rgba(0,0,0,1)');
      gradient.addColorStop(1, 'rgba(0,0,0,0)');

      cropCtx.fillStyle = gradient;
      cropCtx.fillRect(0, 0, destWidth, destHeight); // Apply the gradient to the whole crop canvas
      
      // Reset composite operation to default
      cropCtx.globalCompositeOperation = 'source-over';

      // 4. Draw the now-feathered crop onto the main canvas at the correct position
      ctx.drawImage(cropCanvas, destX, destY, destWidth, destHeight);

      resolve(canvas.toDataURL('image/png'));
    };
    
    originalImage.onload = () => { originalLoaded = true; onImagesLoaded(); };
    generatedCropImage.onload = () => { cropLoaded = true; onImagesLoaded(); };
    originalImage.onerror = () => reject(new Error("Failed to load original image"));
    generatedCropImage.onerror = () => reject(new Error("Failed to load generated crop image"));

    originalImage.src = originalUrl;
    generatedCropImage.src = generatedCropUrl;
  });
};


// --- UI COMPONENTS (Defined outside App to prevent re-renders) ---

interface ImageUploaderProps {
  onImageSelect: (imageDataUrl: string) => void;
  onUseCamera: () => void;
}
const ImageUploader: React.FC<ImageUploaderProps> = ({ onImageSelect, onUseCamera }) => {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const reader = new FileReader();
      reader.onload = (event) => {
        onImageSelect(event.target?.result as string);
      };
      reader.readAsDataURL(e.target.files[0]);
    }
  };

  return (
    <div className="w-full max-w-lg text-center p-8 bg-gray-800 rounded-2xl shadow-2xl border border-gray-700">
      <h2 className="text-3xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-purple-500 mb-4">Face Unmasker AI</h2>
      <p className="text-gray-400 mb-8">Upload or capture a photo of a person with a mask to see their face.</p>
      <div className="space-y-4">
        <button onClick={() => inputRef.current?.click()} className="w-full flex items-center justify-center bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 px-4 rounded-lg transition-transform transform hover:scale-105">
          <UploadIcon /> Upload Image
        </button>
        <button onClick={onUseCamera} className="w-full flex items-center justify-center bg-gray-600 hover:bg-gray-700 text-white font-bold py-3 px-4 rounded-lg transition-transform transform hover:scale-105">
          <CameraIcon /> Use Camera
        </button>
      </div>
      <input type="file" ref={inputRef} onChange={handleFileChange} accept="image/*" className="hidden" />
    </div>
  );
};

interface CameraCaptureProps {
    onCapture: (imageDataUrl: string) => void;
    onBack: () => void;
}
const CameraCapture: React.FC<CameraCaptureProps> = ({ onCapture, onBack }) => {
    const videoRef = useRef<HTMLVideoElement>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const startCamera = async () => {
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
                if (videoRef.current) {
                    videoRef.current.srcObject = stream;
                }
            } catch (err) {
                console.error("Error accessing camera:", err);
                setError("Could not access camera. Please check permissions and try again.");
            }
        };
        startCamera();
        return () => {
            if (videoRef.current && videoRef.current.srcObject) {
                const stream = videoRef.current.srcObject as MediaStream;
                stream.getTracks().forEach(track => track.stop());
            }
        };
    }, []);

    const handleCapture = () => {
        if (videoRef.current) {
            const canvas = document.createElement('canvas');
            canvas.width = videoRef.current.videoWidth;
            canvas.height = videoRef.current.videoHeight;
            const context = canvas.getContext('2d');
            context?.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);
            onCapture(canvas.toDataURL('image/jpeg'));
        }
    };

    return (
        <div className="w-full max-w-2xl text-center p-6 bg-gray-800 rounded-2xl shadow-2xl border border-gray-700">
            {error ? <p className="text-red-400">{error}</p> : (
                <>
                    <video ref={videoRef} autoPlay playsInline className="w-full rounded-lg mb-4" />
                    <div className="flex justify-center space-x-4">
                        <button onClick={onBack} className="flex items-center justify-center bg-gray-600 hover:bg-gray-700 text-white font-bold py-3 px-4 rounded-lg">
                            <BackIcon /> Back
                        </button>
                        <button onClick={handleCapture} className="flex items-center justify-center bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 px-4 rounded-lg">
                            <CameraIcon /> Capture
                        </button>
                    </div>
                </>
            )}
        </div>
    );
};

interface ImageCropperProps {
  imageSrc: string;
  onProcess: (croppedImageDataUrl: string, cropRect: CropRect, displaySize: { width: number; height: number }, age: string) => void;
  onBack: () => void;
}
const ImageCropper: React.FC<ImageCropperProps> = ({ imageSrc, onProcess, onBack }) => {
  const [crop, setCrop] = useState<CropRect | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [age, setAge] = useState<string>('Unspecified');
  const startPos = useRef({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);

  const getEventCoordinates = (e: React.MouseEvent | React.TouchEvent): { x: number, y: number } | null => {
    if (!containerRef.current) return null;
    const rect = containerRef.current.getBoundingClientRect();
    let clientX: number, clientY: number;

    if ('touches' in e) {
      if (e.touches.length === 0) return null;
      clientX = e.touches[0].clientX;
      clientY = e.touches[0].clientY;
    } else {
      clientX = e.clientX;
      clientY = e.clientY;
    }

    return {
      x: clientX - rect.left,
      y: clientY - rect.top,
    };
  };

  const handleInteractionStart = (e: React.MouseEvent | React.TouchEvent) => {
    const coords = getEventCoordinates(e);
    if (!coords) return;
    
    setIsDrawing(true);
    startPos.current = coords;
    setCrop({ ...coords, width: 0, height: 0 });
  };

  const handleInteractionMove = (e: React.MouseEvent | React.TouchEvent) => {
    if (!isDrawing) return;
    
    const coords = getEventCoordinates(e);
    if (!coords) return;

    setCrop({
      x: Math.min(startPos.current.x, coords.x),
      y: Math.min(startPos.current.y, coords.y),
      width: Math.abs(coords.x - startPos.current.x),
      height: Math.abs(coords.y - startPos.current.y),
    });
  };

  const handleInteractionEnd = () => {
    setIsDrawing(false);
  };

  const handleProcess = () => {
    if (!crop || !imageRef.current || crop.width === 0 || crop.height === 0) return;
    const img = imageRef.current;
    const scaleX = img.naturalWidth / img.clientWidth;
    const scaleY = img.naturalHeight / img.clientHeight;

    const canvas = document.createElement('canvas');
    canvas.width = crop.width * scaleX;
    canvas.height = crop.height * scaleY;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.drawImage(
      img,
      crop.x * scaleX,
      crop.y * scaleY,
      crop.width * scaleX,
      crop.height * scaleY,
      0,
      0,
      canvas.width,
      canvas.height
    );
    onProcess(canvas.toDataURL('image/png'), crop, { width: img.clientWidth, height: img.clientHeight }, age);
  };

  return (
    <div className="w-full max-w-4xl text-center p-6 bg-gray-800 rounded-2xl shadow-2xl border border-gray-700">
      <h2 className="text-2xl font-bold mb-4">Crop The Face</h2>
      <p className="text-gray-400 mb-4">Click and drag on the image to select the area with the masked face.</p>
      <div
        ref={containerRef}
        className="relative select-none cursor-crosshair"
        onMouseDown={handleInteractionStart}
        onMouseMove={handleInteractionMove}
        onMouseUp={handleInteractionEnd}
        onMouseLeave={handleInteractionEnd}
        onTouchStart={handleInteractionStart}
        onTouchMove={handleInteractionMove}
        onTouchEnd={handleInteractionEnd}
        onTouchCancel={handleInteractionEnd}
      >
        <img ref={imageRef} src={imageSrc} alt="To be cropped" className="max-w-full max-h-[70vh] rounded-lg" style={{ touchAction: 'none' }} />
        {crop && (
          <div
            className="absolute border-2 border-dashed border-blue-400 bg-black bg-opacity-40"
            style={{
              left: crop.x,
              top: crop.y,
              width: crop.width,
              height: crop.height,
            }}
          />
        )}
      </div>
      <div className="mt-6">
          <label htmlFor="age-select" className="block text-sm font-medium text-gray-300 mb-2">Approximate Age</label>
          <select
              id="age-select"
              value={age}
              onChange={(e) => setAge(e.target.value)}
              className="w-full max-w-xs mx-auto bg-gray-700 border border-gray-600 text-white rounded-lg focus:ring-blue-500 focus:border-blue-500 block p-2.5"
              aria-label="Select approximate age of the person"
          >
              <option value="Unspecified">Unspecified</option>
              <option value="Child (0-12)">Child (0-12)</option>
              <option value="Teenager (13-19)">Teenager (13-19)</option>
              <option value="Young Adult (20-35)">Young Adult (20-35)</option>
              <option value="Adult (36-55)">Adult (36-55)</option>
              <option value="Senior (56+)">Senior (56+)</option>
          </select>
      </div>
      <div className="mt-6 flex justify-center space-x-4">
          <button onClick={onBack} className="flex items-center justify-center bg-gray-600 hover:bg-gray-700 text-white font-bold py-3 px-4 rounded-lg">
                <BackIcon /> Back
          </button>
          <button onClick={handleProcess} disabled={!crop || crop.width < 10} className="flex items-center justify-center bg-purple-600 hover:bg-purple-700 text-white font-bold py-3 px-4 rounded-lg transition-colors disabled:bg-gray-500 disabled:cursor-not-allowed">
              <MagicWandIcon /> Unmask This Area
          </button>
      </div>
    </div>
  );
};


interface ResultDisplayProps {
  originalImage: string;
  generatedImage: string;
  onReset: () => void;
  onEdit: (prompt: string) => void;
  isEditing: boolean;
}
const ResultDisplay: React.FC<ResultDisplayProps> = ({ originalImage, generatedImage, onReset, onEdit, isEditing }) => {
    const [prompt, setPrompt] = useState('');

    const handleDownload = () => {
        const link = document.createElement('a');
        link.href = generatedImage;
        link.download = 'unmasked-image.png';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    const handleEditClick = () => {
        if (prompt && !isEditing) {
            onEdit(prompt);
        }
    };

    return (
        <div className="w-full max-w-5xl text-center p-6 bg-gray-800 rounded-2xl shadow-2xl border border-gray-700">
            <h2 className="text-3xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-purple-500 mb-6">Result</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                    <h3 className="text-xl font-semibold mb-2 text-gray-300">Before</h3>
                    <img src={originalImage} alt="Original with mask" className="rounded-lg shadow-lg" />
                </div>
                <div>
                    <h3 className="text-xl font-semibold mb-2 text-gray-300">After</h3>
                    <img src={generatedImage} alt="Mask removed" className="rounded-lg shadow-lg" />
                </div>
            </div>

            <div className="mt-8 border-t border-gray-700 pt-6">
                <h3 className="text-xl font-semibold mb-2 text-gray-300">Refine the Image</h3>
                <p className="text-gray-400 mb-4">Not quite right? Describe what you want to change.</p>
                <div className="flex flex-col sm:flex-row gap-2 max-w-2xl mx-auto">
                    <input
                        type="text"
                        value={prompt}
                        onChange={(e) => setPrompt(e.target.value)}
                        placeholder='e.g., "make them smile", "add sunglasses"'
                        className="flex-grow bg-gray-700 border border-gray-600 text-white rounded-lg focus:ring-blue-500 focus:border-blue-500 p-3 disabled:opacity-50"
                        disabled={isEditing}
                        aria-label="Image editing prompt"
                    />
                    <button
                        onClick={handleEditClick}
                        disabled={!prompt.trim() || isEditing}
                        className="flex items-center justify-center bg-purple-600 hover:bg-purple-700 text-white font-bold py-3 px-6 rounded-lg transition-colors disabled:bg-gray-500 disabled:cursor-not-allowed"
                    >
                        {isEditing ? (
                            <>
                                <span className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin mr-2" role="status" aria-live="polite"></span>
                               <span>Editing...</span>
                            </>
                        ) : (
                           <>
                                <MagicWandIcon /> 
                               <span>Apply Edit</span>
                           </>
                        )}
                    </button>
                </div>
            </div>

            <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-4">
                <button onClick={onReset} className="w-full sm:w-auto flex items-center justify-center bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 px-6 rounded-lg transition-transform transform hover:scale-105">
                    <ResetIcon /> Start Over
                </button>
                <button onClick={handleDownload} className="w-full sm:w-auto flex items-center justify-center bg-green-600 hover:bg-green-700 text-white font-bold py-3 px-6 rounded-lg transition-transform transform hover:scale-105">
                    <DownloadIcon /> Download Image
                </button>
            </div>
        </div>
    );
};

const LoadingSpinner = () => (
    <div className="flex flex-col items-center justify-center text-center p-8 bg-gray-800 rounded-2xl shadow-2xl border border-gray-700">
        <div className="w-16 h-16 border-4 border-blue-400 border-t-transparent rounded-full animate-spin mb-4"></div>
        <h2 className="text-2xl font-bold text-gray-200">AI is thinking...</h2>
        <p className="text-gray-400 mt-2">Removing the mask and revealing the face.</p>
    </div>
);

const ErrorDisplay: React.FC<{ message: string; onReset: () => void }> = ({ message, onReset }) => (
    <div className="w-full max-w-lg text-center p-8 bg-red-900 bg-opacity-30 border border-red-500 rounded-2xl shadow-2xl">
        <h2 className="text-2xl font-bold text-red-400 mb-4">An Error Occurred</h2>
        <p className="text-red-300 mb-6">{message}</p>
        <button onClick={onReset} className="flex items-center justify-center mx-auto bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 px-6 rounded-lg">
            <ResetIcon /> Try Again
        </button>
    </div>
);

// --- MAIN APP COMPONENT ---

export default function App() {
  const [appState, setAppState] = useState<AppState>(AppState.IDLE);
  const [originalImage, setOriginalImage] = useState<string | null>(null);
  const [croppedImage, setCroppedImage] = useState<string | null>(null);
  const [generatedImage, setGeneratedImage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);


  useEffect(() => {
    // Pre-check for API_KEY on load
    if (!process.env.API_KEY) {
        setError("Gemini API key is not configured. This application cannot function without it.");
        setAppState(AppState.ERROR);
    }
  }, []);

  const handleReset = () => {
    setAppState(AppState.IDLE);
    setOriginalImage(null);
    setCroppedImage(null);
    setGeneratedImage(null);
    setError(null);
  };
  
  const handleImageSelect = (imageDataUrl: string) => {
    setOriginalImage(imageDataUrl);
    setAppState(AppState.CROPPING);
  };
  
  const handleUseCamera = () => {
      setAppState(AppState.CAPTURING);
  };

  const handleBackToIdle = () => {
      setAppState(AppState.IDLE);
  };

  const handleProcessImage = useCallback(async (croppedDataUrl: string, cropRect: CropRect, displaySize: { width: number; height: number }, age: string) => {
    setCroppedImage(croppedDataUrl);
    setAppState(AppState.GENERATING);
    if (!originalImage) {
      setError("Original image was lost. Please start over.");
      setAppState(AppState.ERROR);
      return;
    }

    try {
      const generatedCropUrl = await removeMask(croppedDataUrl, age);
      const fullGeneratedImage = await stitchImages(
        originalImage,
        generatedCropUrl,
        cropRect,
        displaySize
      );
      setGeneratedImage(fullGeneratedImage);
      setAppState(AppState.RESULT_SHOWN);
    } catch (err) {
      if (err instanceof Error) {
        setError(err.message);
      } else {
        setError("An unknown error occurred during image processing.");
      }
      setAppState(AppState.ERROR);
    }
  }, [originalImage]);

  const handleEditImage = useCallback(async (prompt: string) => {
    if (!generatedImage) {
        setError("No generated image to edit. Please start over.");
        setAppState(AppState.ERROR);
        return;
    }

    setIsEditing(true);

    try {
        const editedImage = await editImage(generatedImage, prompt);
        setGeneratedImage(editedImage);
    } catch (err) {
        if (err instanceof Error) {
            setError(err.message);
        } else {
            setError("An unknown error occurred during image editing.");
        }
        setAppState(AppState.ERROR);
    } finally {
        setIsEditing(false);
    }
  }, [generatedImage]);


  const renderContent = () => {
    switch (appState) {
      case AppState.IDLE:
        return <ImageUploader onImageSelect={handleImageSelect} onUseCamera={handleUseCamera} />;
      case AppState.CAPTURING:
        return <CameraCapture onCapture={handleImageSelect} onBack={handleBackToIdle} />;
      case AppState.CROPPING:
        return originalImage && <ImageCropper imageSrc={originalImage} onProcess={handleProcessImage} onBack={handleReset} />;
      case AppState.GENERATING:
        return <LoadingSpinner />;
      case AppState.RESULT_SHOWN:
        return originalImage && generatedImage && <ResultDisplay originalImage={originalImage} generatedImage={generatedImage} onReset={handleReset} onEdit={handleEditImage} isEditing={isEditing} />;
      case AppState.ERROR:
        return error && <ErrorDisplay message={error} onReset={handleReset} />;
      default:
        return <p>Invalid state</p>;
    }
  };

  return (
    <main className="min-h-screen w-full bg-gray-900 text-gray-100 flex flex-col items-center justify-center p-4">
      {renderContent()}
    </main>
  );
}