import { useMemo, useState } from 'react';
import {
  ArrowLeft,
  Film,
  Layers,
  LogIn,
  Pause,
  Play,
  Radio,
  Tv,
  User,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import {
  LIVE_CHANNELS,
  PLATFORM_LABELS,
  RADIO_STATIONS,
} from '../data/catalog';
import {
  CatalogItem,
  EpgProgram,
  LiveChannel,
  NavSection,
  RadioStation,
} from '../types/streaming';
import { MediaImage } from './MediaImage';

interface CatalogGridViewProps {
  title: string;
  subtitle: string;
  items: CatalogItem[];
  onSelectItem: (item: CatalogItem) => void;
  onPlay: (item: CatalogItem) => void;
}

export function CatalogGridView({
  title,
  subtitle,
  items,
  onSelectItem,
  onPlay,
}: CatalogGridViewProps) {
  const [selectedGenre, setSelectedGenre] = useState<string>('Todos');

  const genres = [
    'Todos',
    ...Array.from(new Set(items.flatMap((i) => i.genres))).slice(0, 6),
  ];

  const visibleItems =
    selectedGenre === 'Todos'
      ? items
      : items.filter((i) => i.genres.includes(selectedGenre));

  return (
    <main className="mx-auto min-h-screen max-w-[1440px] px-4 pt-28 pb-20 sm:px-8 lg:px-12">
      <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="font-display text-3xl font-extrabold tracking-tight text-white">
            {title}
          </h1>
          <p className="mt-1 text-sm text-white/60">{subtitle}</p>
        </div>

        <div className="flex flex-wrap gap-1.5 rounded-lg border border-white/10 bg-[#121417] p-1">
          {genres.map((genre) => (
            <button
              key={genre}
              type="button"
              onClick={() => setSelectedGenre(genre)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                selectedGenre === genre
                  ? 'bg-white text-[#0B0C0E]'
                  : 'text-white/70 hover:text-white'
              }`}
            >
              {genre}
            </button>
          ))}
        </div>
      </div>

      {visibleItems.length === 0 ? (
        <div className="rounded-xl border border-white/10 bg-[#121417] p-12 text-center text-sm text-white/60">
          Nenhum título publicado nesta categoria.
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {visibleItems.map((item) => (
            <div
              key={item.id}
              onClick={() => onSelectItem(item)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelectItem(item);
                }
              }}
              className="group relative cursor-pointer overflow-hidden rounded-[8px] border border-white/10 bg-[#121417]"
            >
              <div className="relative aspect-[2/3] w-full overflow-hidden">
                <MediaImage
                  src={item.posterImage}
                  alt={item.title}
                  className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                />
                <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/90 via-black/15 to-transparent" />
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onPlay(item);
                  }}
                  aria-label={`Assistir ${item.title}`}
                  className="absolute right-3 bottom-14 flex h-9 w-9 items-center justify-center rounded-full bg-white text-[#0B0C0E] opacity-0 transition-opacity group-hover:opacity-100"
                >
                  <Play className="h-4 w-4 fill-current ml-0.5" />
                </button>
                <div className="absolute inset-x-0 bottom-0 p-3">
                  <p className="line-clamp-1 text-sm font-semibold text-white">
                    {item.title}
                  </p>
                  <p className="mt-0.5 text-[11px] text-white/60 tabular-nums">
                    {PLATFORM_LABELS[item.platform]} · {item.year}
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}

function formatClock(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function resolveEpgForChannel(
  item: CatalogItem,
  epgPrograms: EpgProgram[]
): { current?: EpgProgram; next?: EpgProgram; progressPercent: number } {
  if (epgPrograms.length === 0) return { progressPercent: 0 };

  const candidates = [item.tvgId, item.tvgName, item.title]
    .filter((v): v is string => Boolean(v && v.trim()))
    .map((v) => v.trim().toLowerCase());

  if (candidates.length === 0) return { progressPercent: 0 };

  const channelProgs = epgPrograms
    .filter((p) => candidates.includes(p.channelId.trim().toLowerCase()))
    .sort((a, b) => a.startMs - b.startMs);

  if (channelProgs.length === 0) return { progressPercent: 0 };

  const now = Date.now();
  const current = channelProgs.find((p) => p.startMs <= now && p.stopMs > now);
  const next = current
    ? channelProgs.find((p) => p.startMs >= current.stopMs)
    : channelProgs.find((p) => p.startMs > now);

  const progressPercent = current
    ? Math.min(
        100,
        Math.max(
          2,
          Math.round(
            ((now - current.startMs) / (current.stopMs - current.startMs)) * 100
          )
        )
      )
    : 0;

  return { current, next, progressPercent };
}

export function LiveTvView({
  publishedLiveItems = [],
  epgPrograms = [],
  onPlayItem,
  onBackHome,
}: {
  publishedLiveItems?: CatalogItem[];
  epgPrograms?: EpgProgram[];
  onPlayItem?: (item: CatalogItem) => void;
  onBackHome: () => void;
}) {
  const [groupFilter, setGroupFilter] = useState('Todos');

  const channels = useMemo<
    Array<LiveChannel & { item?: CatalogItem; sourcesCount: number }>
  >(() => {
    if (publishedLiveItems.length === 0) {
      return LIVE_CHANNELS.map((c) => ({ ...c, sourcesCount: 1 }));
    }

    return publishedLiveItems.map((item, idx) => {
      const epg = resolveEpgForChannel(item, epgPrograms);
      return {
        id: item.id,
        number: String(101 + idx),
        name: item.title,
        category: item.genres[0] || 'TV ao Vivo',
        currentProgram: epg.current
          ? `${formatClock(epg.current.startMs)} · ${epg.current.title}`
          : 'Transmissão ao Vivo',
        nextProgram: epg.next
          ? `${formatClock(epg.next.startMs)} · ${epg.next.title}`
          : 'Grade contínua 24h',
        progressPercent: epg.current ? epg.progressPercent : 45,
        backdropImage: item.backdropImage || item.posterImage,
        logoImage: item.tvgLogo || item.posterImage,
        tvgId: item.tvgId,
        streamUrl: item.sources?.[0]?.url,
        item,
        sourcesCount: item.sources?.length ?? 0,
      };
    });
  }, [publishedLiveItems, epgPrograms]);

  const groups = useMemo(
    () => [
      'Todos',
      ...Array.from(new Set(channels.map((c) => c.category))).slice(0, 7),
    ],
    [channels]
  );

  const visibleChannels = useMemo(
    () =>
      groupFilter === 'Todos'
        ? channels
        : channels.filter((c) => c.category === groupFilter),
    [channels, groupFilter]
  );

  const [activeChannelId, setActiveChannelId] = useState(channels[0]?.id ?? '');
  const activeChannel =
    channels.find((c) => c.id === activeChannelId) ?? visibleChannels[0] ?? channels[0];

  return (
    <main className="mx-auto min-h-screen max-w-[1440px] px-4 pt-28 pb-20 sm:px-8 lg:px-12">
      <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold tracking-wider text-[#E50914] uppercase">
            <Tv className="h-4 w-4" />
            {publishedLiveItems.length > 0
              ? `Canais Publicados (${publishedLiveItems.length})`
              : 'Transmissão Preparatória'}
          </div>
          <h1 className="mt-1 font-display text-3xl font-extrabold tracking-tight text-white">
            TV ao Vivo
          </h1>
        </div>
        <button
          type="button"
          onClick={onBackHome}
          className="inline-flex items-center gap-2 rounded-lg border border-white/15 bg-[#121417] px-4 py-2 text-xs font-semibold text-white/85 hover:bg-white/10"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Voltar ao Início
        </button>
      </div>

      {/* Active Channel Hero Card */}
      {activeChannel && (
        <div className="mb-8 overflow-hidden rounded-xl border border-white/10 bg-[#121417]">
          <div className="relative flex min-h-[240px] flex-col justify-between gap-6 p-6 sm:flex-row sm:items-end sm:p-8">
            <MediaImage
              src={activeChannel.backdropImage}
              alt={activeChannel.name}
              className="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-25 blur-sm"
            />
            <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-[#0B0C0E]/95 via-[#0B0C0E]/80 to-[#0B0C0E]/60" />

            <div className="relative z-10 flex items-center gap-5">
              {/* Channel Logo Box */}
              <div className="flex h-20 w-24 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-white/15 bg-[#0B0C0E]/90 p-2">
                <MediaImage
                  src={activeChannel.logoImage || activeChannel.backdropImage}
                  alt={activeChannel.name}
                  className="max-h-full max-w-full object-contain"
                />
              </div>

              <div className="space-y-1.5">
                <p className="text-xs font-semibold text-[#E50914] tabular-nums">
                  Canal {activeChannel.number} · {activeChannel.category}
                  {activeChannel.sourcesCount > 1
                    ? ` · ${activeChannel.sourcesCount} fontes agrupadas`
                    : ''}
                  {activeChannel.tvgId ? ` · EPG: ${activeChannel.tvgId}` : ''}
                </p>
                <h2 className="font-display text-2xl font-bold text-white sm:text-3xl">
                  {activeChannel.name}
                </h2>
                <p className="text-sm text-white/90">
                  <span className="font-semibold text-white/55">Agora: </span>
                  {activeChannel.currentProgram}
                </p>
                <p className="text-xs text-white/60">
                  <span className="font-semibold text-white/45">A seguir: </span>
                  {activeChannel.nextProgram}
                </p>
              </div>
            </div>

            <div className="relative z-10 flex items-center gap-3 shrink-0">
              {activeChannel.item && onPlayItem ? (
                <button
                  type="button"
                  onClick={() => onPlayItem(activeChannel.item!)}
                  className="inline-flex h-11 items-center gap-2 rounded-lg bg-white px-5 text-sm font-bold text-[#0B0C0E] shadow-lg transition-transform hover:scale-[1.02]"
                >
                  <Play className="h-4 w-4 fill-current" />
                  Assistir Agora
                </button>
              ) : (
                <span className="rounded-[4px] border border-white/20 bg-black/60 px-3 py-1.5 text-xs font-semibold text-white">
                  Sinal HD Simulado
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Group Filter Pills */}
      {groups.length > 2 && (
        <div className="mb-6 flex flex-wrap gap-1.5">
          {groups.map((grp) => (
            <button
              key={grp}
              type="button"
              onClick={() => setGroupFilter(grp)}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                groupFilter === grp
                  ? 'bg-white text-[#0B0C0E]'
                  : 'border border-white/10 bg-[#121417] text-white/70 hover:text-white'
              }`}
            >
              {grp}
            </button>
          ))}
        </div>
      )}

      {/* Channels Grid with Mandatory Logo & EPG */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {visibleChannels.map((channel) => {
          const active = channel.id === activeChannel?.id;
          return (
            <div
              key={channel.id}
              onClick={() => setActiveChannelId(channel.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setActiveChannelId(channel.id);
                }
              }}
              className={`group flex cursor-pointer flex-col justify-between rounded-xl border p-4 text-left transition-colors ${
                active
                  ? 'border-[#E50914] bg-[#181B20]'
                  : 'border-white/10 bg-[#121417] hover:border-white/25'
              }`}
            >
              <div>
                <div className="flex items-center justify-between gap-2 text-xs text-white/55 tabular-nums">
                  <span>
                    Canal {channel.number} · {channel.category}
                  </span>
                  {channel.sourcesCount > 1 && (
                    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-white/75">
                      <Layers className="h-3 w-3 text-[#E50914]" />
                      {channel.sourcesCount} fontes
                    </span>
                  )}
                </div>

                {/* Channel Logo + Title */}
                <div className="mt-3 flex items-center gap-3.5">
                  <div className="flex h-12 w-16 shrink-0 items-center justify-center overflow-hidden rounded-md border border-white/10 bg-[#0B0C0E] p-1.5">
                    <MediaImage
                      src={channel.logoImage || channel.backdropImage}
                      alt={channel.name}
                      className="max-h-full max-w-full object-contain"
                    />
                  </div>
                  <div className="min-w-0">
                    <p className="truncate font-display text-base font-bold text-white">
                      {channel.name}
                    </p>
                    {channel.item?.sources && channel.item.sources.length > 0 && (
                      <p className="truncate text-[11px] text-white/50">
                        {channel.item.sources
                          .map((s) => s.qualityTag || s.label)
                          .join(' · ')}
                      </p>
                    )}
                  </div>
                </div>

                {/* EPG Now & Next */}
                <div className="mt-3.5 space-y-1 text-xs">
                  <p className="line-clamp-1 text-white/85">
                    <span className="font-semibold text-[#E50914]">Agora: </span>
                    {channel.currentProgram}
                  </p>
                  <p className="line-clamp-1 text-white/55">
                    <span className="font-medium text-white/45">A seguir: </span>
                    {channel.nextProgram}
                  </p>
                </div>
              </div>

              <div className="mt-3 space-y-2.5">
                <div className="h-1 w-full overflow-hidden rounded-full bg-white/15">
                  <div
                    className="h-full bg-[#E50914]"
                    style={{ width: `${channel.progressPercent}%` }}
                  />
                </div>

                {channel.item && onPlayItem && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onPlayItem(channel.item!);
                    }}
                    className="inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-md bg-white/10 text-xs font-semibold text-white transition-colors hover:bg-white hover:text-[#0B0C0E]"
                  >
                    <Play className="h-3.5 w-3.5 fill-current" />
                    Assistir Canal
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </main>
  );
}

export function RadioView({
  publishedRadioItems = [],
  onBackHome,
}: {
  publishedRadioItems?: CatalogItem[];
  onBackHome: () => void;
}) {
  const stations: RadioStation[] =
    publishedRadioItems.length > 0
      ? publishedRadioItems.map((item, idx) => ({
          id: item.id,
          frequency: `WEB ${idx + 1}`,
          name: item.title,
          genre: item.genres[0] || 'Rádio Online',
          currentTrack: 'Transmissão ao vivo',
          artist: item.director || 'Importação M3U',
          accentHex: '#E50914',
          logoImage: item.tvgLogo || item.posterImage,
          streamUrl: item.sources?.[0]?.url,
        }))
      : RADIO_STATIONS;

  const [playingStationId, setPlayingStationId] = useState<string | null>(
    stations[0]?.id ?? null
  );

  return (
    <main className="mx-auto min-h-screen max-w-[1440px] px-4 pt-28 pb-20 sm:px-8 lg:px-12">
      <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold tracking-wider text-[#E50914] uppercase">
            <Radio className="h-4 w-4" />
            {publishedRadioItems.length > 0
              ? `Estações Publicadas (${publishedRadioItems.length})`
              : 'Estações Digitais'}
          </div>
          <h1 className="mt-1 font-display text-3xl font-extrabold tracking-tight text-white">
            Rádios & Trilhas
          </h1>
        </div>
        <button
          type="button"
          onClick={onBackHome}
          className="inline-flex items-center gap-2 rounded-lg border border-white/15 bg-[#121417] px-4 py-2 text-xs font-semibold text-white/85 hover:bg-white/10"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Voltar ao Início
        </button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stations.map((station) => {
          const isPlaying = playingStationId === station.id;
          return (
            <div
              key={station.id}
              className={`flex flex-col justify-between rounded-xl border p-5 transition-colors ${
                isPlaying
                  ? 'border-white/35 bg-[#181B20]'
                  : 'border-white/10 bg-[#121417]'
              }`}
            >
              <div>
                <div className="flex items-center justify-between text-xs text-white/55 tabular-nums">
                  <span className="font-semibold">{station.frequency}</span>
                  <span>{station.genre}</span>
                </div>
                <h2 className="mt-3 font-display text-xl font-bold text-white">
                  {station.name}
                </h2>
                <p className="mt-2 text-xs font-medium text-white/80">
                  {station.currentTrack}
                </p>
                <p className="text-xs text-white/50">{station.artist}</p>
              </div>

              <div className="mt-6 flex items-center justify-between border-t border-white/10 pt-4">
                <span className="text-xs text-white/55">
                  {isPlaying ? 'Reproduzindo' : 'Pausada'}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    setPlayingStationId(isPlaying ? null : station.id)
                  }
                  aria-label={
                    isPlaying
                      ? `Pausar ${station.name}`
                      : `Tocar ${station.name}`
                  }
                  className="flex h-10 w-10 items-center justify-center rounded-full bg-white text-[#0B0C0E] transition-transform hover:scale-105"
                >
                  {isPlaying ? (
                    <Pause className="h-4 w-4 fill-current" />
                  ) : (
                    <Play className="h-4 w-4 fill-current ml-0.5" />
                  )}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </main>
  );
}

interface ProfileViewProps {
  userName: string;
  userEmail: string;
  myListItems: CatalogItem[];
  onSelectItem: (item: CatalogItem) => void;
  onNavigate: (section: NavSection) => void;
  onLogout: () => void;
}

export function ProfileView({
  userName,
  userEmail,
  myListItems,
  onSelectItem,
  onNavigate,
  onLogout,
}: ProfileViewProps) {
  return (
    <main className="mx-auto min-h-screen max-w-[1440px] px-4 pt-28 pb-20 sm:px-8 lg:px-12">
      <div className="mb-10 flex flex-col justify-between gap-6 rounded-xl border border-white/10 bg-[#121417] p-6 sm:flex-row sm:items-center">
        <div className="flex items-center gap-4">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-[#E50914] font-display text-2xl font-bold text-white">
            {userName.charAt(0).toUpperCase()}
          </div>
          <div>
            <h1 className="font-display text-2xl font-bold text-white">
              {userName}
            </h1>
            <p className="text-sm text-white/60">
              {userEmail} · Plano Aura 4K Integrado
            </p>
          </div>
        </div>

        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => onNavigate('login')}
            className="rounded-lg border border-white/15 bg-[#181B20] px-4 py-2 text-xs font-semibold text-white hover:bg-white/10"
          >
            Trocar conta
          </button>
          <button
            type="button"
            onClick={onLogout}
            className="rounded-lg border border-[#E50914]/40 bg-[#E50914]/15 px-4 py-2 text-xs font-semibold text-white hover:bg-[#E50914]/25"
          >
            Sair da conta
          </button>
        </div>
      </div>

      <section className="space-y-4">
        <div className="flex items-baseline justify-between">
          <h2 className="font-display text-xl font-bold text-white">
            Minha Lista ({myListItems.length})
          </h2>
          <button
            type="button"
            onClick={() => onNavigate('home')}
            className="text-xs font-medium text-white/65 hover:text-white"
          >
            Explorar catálogo
          </button>
        </div>

        {myListItems.length === 0 ? (
          <div className="rounded-xl border border-white/10 bg-[#121417] p-12 text-center">
            <Film className="mx-auto mb-3 h-8 w-8 text-white/30" />
            <p className="text-sm font-medium text-white">
              Sua lista está vazia
            </p>
            <p className="mt-1 text-xs text-white/55">
              Adicione filmes e séries clicando em “+ Minha Lista” nos cards ou
              no modal de detalhes.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-5">
            {myListItems.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelectItem(item)}
                className="group relative aspect-[2/3] overflow-hidden rounded-[8px] border border-white/10 bg-[#121417] text-left"
              >
                <MediaImage
                  src={item.posterImage}
                  alt={item.title}
                  className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-transparent to-transparent" />
                <p className="absolute inset-x-0 bottom-0 p-3 text-xs font-semibold text-white">
                  {item.title}
                </p>
              </button>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

interface LoginViewProps {
  onLoginSuccess: (name: string, email: string) => void;
  onCancel: () => void;
}

export function LoginView({ onLoginSuccess, onCancel }: LoginViewProps) {
  const { signInWithGoogle, authError } = useAuth();
  const [signingIn, setSigningIn] = useState(false);

  const handleGoogleLogin = async () => {
    setSigningIn(true);
    try {
      const signedUser = await signInWithGoogle();
      if (signedUser) {
        const displayName =
          signedUser.displayName ||
          signedUser.email?.split('@')[0] ||
          'Assinante';
        onLoginSuccess(
          displayName,
          signedUser.email || 'conta@centraltv.app'
        );
      }
    } finally {
      setSigningIn(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center px-4 pt-24 pb-16">
      <div className="w-full max-w-md rounded-xl border border-white/12 bg-[#121417] p-8 shadow-2xl">
        <div className="mb-6 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <User className="h-5 w-5 text-[#E50914]" />
            <h1 className="font-display text-2xl font-bold text-white">
              Entrar na Aura Stream
            </h1>
          </div>
        </div>

        <p className="mb-6 text-sm text-white/60">
          Entre com sua conta Google para sincronizar sua Minha Lista e o
          progresso de Continuar Assistindo entre sessões.
        </p>

        {authError && (
          <div className="mb-4 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3.5 py-2.5 text-xs text-rose-200">
            {authError}
          </div>
        )}

        <button
          type="button"
          disabled={signingIn}
          onClick={() => void handleGoogleLogin()}
          className="inline-flex h-11 w-full items-center justify-center gap-2.5 rounded-lg bg-[#E50914] text-sm font-bold text-white transition-colors hover:bg-[#c80812] disabled:opacity-60"
        >
          <LogIn className="h-4 w-4" />
          {signingIn ? 'Conectando...' : 'Entrar com Google'}
        </button>

        <button
          type="button"
          onClick={onCancel}
          className="mt-4 w-full text-center text-xs font-medium text-white/55 hover:text-white"
        >
          Voltar para a Home sem entrar
        </button>
      </div>
    </main>
  );
}
