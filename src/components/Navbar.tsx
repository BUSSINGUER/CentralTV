import { useEffect, useRef, useState } from 'react';
import {
  Search,
  ShieldCheck,
  User,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import { NavSection } from '../types/streaming';

interface NavbarProps {
  activeSection: NavSection;
  onNavigate: (section: NavSection) => void;
  searchQuery: string;
  onSearchChange: (value: string) => void;
  isHeroMuted: boolean;
  onToggleHeroMute: () => void;
  isLoggedIn: boolean;
}

const NAV_ITEMS: { id: NavSection; label: string }[] = [
  { id: 'home', label: 'Início' },
  { id: 'movies', label: 'Filmes' },
  { id: 'series', label: 'Séries' },
  { id: 'live', label: 'TV ao Vivo' },
  { id: 'radio', label: 'Rádios' },
];

export function Navbar({
  activeSection,
  onNavigate,
  searchQuery,
  onSearchChange,
  isHeroMuted,
  onToggleHeroMute,
  isLoggedIn,
}: NavbarProps) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [isScrolled, setIsScrolled] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onScroll = () => {
      setIsScrolled(window.scrollY > 24);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (searchOpen) {
      inputRef.current?.focus();
    }
  }, [searchOpen]);

  const handleCloseSearch = () => {
    setSearchOpen(false);
    onSearchChange('');
  };

  return (
    <header
      className={`fixed top-0 inset-x-0 z-40 transition-colors duration-200 ${
        isScrolled
          ? 'bg-gradient-to-b from-[#0B0C0E]/90 via-[#0B0C0E]/55 to-transparent'
          : 'bg-gradient-to-b from-[#0B0C0E]/75 to-transparent'
      }`}
    >
      <div className="mx-auto flex max-w-[1440px] items-center justify-between gap-4 px-4 py-3.5 sm:px-8 lg:px-12">
        {/* Brand Wordmark */}
        <button
          type="button"
          onClick={() => onNavigate('home')}
          className="group flex items-center gap-2.5 whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E50914] rounded-md px-1 py-1"
        >
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-[#E50914] font-display text-sm font-black tracking-tighter text-white shadow-lg shadow-[#E50914]/30 transition-transform duration-200 group-hover:scale-105">
            A
          </span>
          <span className="font-display text-lg font-bold tracking-tight text-white">
            Aura Stream
          </span>
        </button>

        {/* Centered Floating Glassmorphism Pill */}
        <nav
          aria-label="Navegação principal"
          className="hidden md:flex items-center gap-1 rounded-full border border-white/12 bg-[#121417]/75 px-2 py-1.5 backdrop-blur-xl shadow-[0_12px_36px_rgba(0,0,0,0.45)]"
        >
          {NAV_ITEMS.map((item) => {
            const isActive = activeSection === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onNavigate(item.id)}
                className={`rounded-full px-4 py-1.5 text-sm font-medium whitespace-nowrap shrink-0 transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 ${
                  isActive
                    ? 'bg-white text-[#0B0C0E] shadow-sm'
                    : 'text-white/75 hover:bg-white/10 hover:text-white'
                }`}
              >
                {item.label}
              </button>
            );
          })}

          <div className="mx-1 h-4 w-px bg-white/15 shrink-0" />

          {searchOpen || searchQuery ? (
            <div className="flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1">
              <Search className="h-4 w-4 text-white/70 shrink-0" />
              <input
                ref={inputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => {
                  onSearchChange(e.target.value);
                  if (activeSection !== 'home') {
                    onNavigate('home');
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    handleCloseSearch();
                  }
                }}
                placeholder="Buscar filmes, séries..."
                aria-label="Buscar no catálogo"
                className="w-40 lg:w-52 bg-transparent text-sm text-white placeholder:text-white/45 focus:outline-none"
              />
              <button
                type="button"
                onClick={handleCloseSearch}
                aria-label="Limpar busca"
                className="rounded-full p-0.5 text-white/60 hover:bg-white/10 hover:text-white"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setSearchOpen(true)}
              aria-label="Abrir busca"
              className="flex h-8 w-8 items-center justify-center rounded-full text-white/80 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
            >
              <Search className="h-4 w-4" />
            </button>
          )}
        </nav>

        {/* Right Discrete Controls: Hero Audio, Admin, Profile */}
        <div className="flex items-center gap-2 shrink-0">
          {activeSection === 'home' && (
            <button
              type="button"
              onClick={onToggleHeroMute}
              title={isHeroMuted ? 'Ativar áudio do trailer' : 'Silenciar trailer'}
              aria-label={
                isHeroMuted ? 'Ativar áudio do trailer' : 'Silenciar trailer'
              }
              className="flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-[#121417]/70 text-white/80 backdrop-blur-md transition-colors hover:border-white/25 hover:bg-white/15 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
            >
              {isHeroMuted ? (
                <VolumeX className="h-4 w-4" />
              ) : (
                <Volume2 className="h-4 w-4 text-[#E50914]" />
              )}
            </button>
          )}

          <button
            type="button"
            onClick={() => onNavigate('admin')}
            title="Painel Administrativo"
            aria-label="Painel Administrativo"
            className={`flex h-10 w-10 items-center justify-center rounded-full border backdrop-blur-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 ${
              activeSection === 'admin'
                ? 'border-[#E50914]/70 bg-[#E50914]/20 text-white'
                : 'border-white/10 bg-[#121417]/70 text-white/75 hover:border-white/25 hover:bg-white/15 hover:text-white'
            }`}
          >
            <ShieldCheck className="h-4 w-4" />
          </button>

          <button
            type="button"
            onClick={() => onNavigate(isLoggedIn ? 'profile' : 'login')}
            title={isLoggedIn ? 'Perfil do Usuário' : 'Entrar'}
            aria-label={isLoggedIn ? 'Perfil do Usuário' : 'Entrar'}
            className={`flex h-10 w-10 items-center justify-center rounded-full border backdrop-blur-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 ${
              activeSection === 'profile' || activeSection === 'login'
                ? 'border-white/60 bg-white text-[#0B0C0E]'
                : 'border-white/10 bg-[#121417]/70 text-white/85 hover:border-white/25 hover:bg-white/15 hover:text-white'
            }`}
          >
            <User className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Compact Mobile Navigation Pill */}
      <div className="flex md:hidden items-center justify-between gap-2 px-4 pb-2.5 overflow-x-auto no-scrollbar">
        <div className="flex items-center gap-1 rounded-full border border-white/10 bg-[#121417]/80 px-1.5 py-1 backdrop-blur-xl">
          {NAV_ITEMS.map((item) => {
            const isActive = activeSection === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onNavigate(item.id)}
                className={`rounded-full px-3 py-1 text-xs font-medium whitespace-nowrap shrink-0 transition-colors ${
                  isActive
                    ? 'bg-white text-[#0B0C0E]'
                    : 'text-white/75 hover:text-white'
                }`}
              >
                {item.label}
              </button>
            );
          })}
        </div>

        <button
          type="button"
          onClick={() => setSearchOpen((prev) => !prev)}
          aria-label="Buscar"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-white/10 bg-[#121417]/80 text-white/80 backdrop-blur-xl"
        >
          <Search className="h-3.5 w-3.5" />
        </button>
      </div>

      {searchOpen && (
        <div className="md:hidden px-4 pb-3">
          <div className="flex items-center gap-2 rounded-full border border-white/15 bg-[#121417]/95 px-3.5 py-2 backdrop-blur-xl">
            <Search className="h-4 w-4 text-white/60 shrink-0" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => {
                onSearchChange(e.target.value);
                if (activeSection !== 'home') {
                  onNavigate('home');
                }
              }}
              placeholder="Buscar títulos, gêneros ou elenco..."
              className="w-full bg-transparent text-sm text-white placeholder:text-white/45 focus:outline-none"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={handleCloseSearch}
                aria-label="Limpar busca"
                className="text-white/60 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
      )}
    </header>
  );
}
