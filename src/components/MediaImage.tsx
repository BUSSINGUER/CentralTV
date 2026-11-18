import { useState } from 'react';
import { Film } from 'lucide-react';

interface MediaImageProps {
  src: string;
  alt: string;
  className?: string;
}

export function MediaImage({ src, alt, className = '' }: MediaImageProps) {
  const [hasError, setHasError] = useState(false);

  if (hasError || !src) {
    return (
      <div
        className={`flex flex-col items-center justify-center bg-gradient-to-br from-[#181B20] via-[#121417] to-[#0B0C0E] p-4 text-center ${className}`}
      >
        <Film className="mb-2 h-7 w-7 text-white/30" />
        <span className="line-clamp-2 text-xs font-medium text-white/60">
          {alt}
        </span>
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      referrerPolicy="no-referrer"
      onError={() => setHasError(true)}
      className={className}
      loading="lazy"
    />
  );
}
