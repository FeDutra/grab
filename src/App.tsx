import { useState, useEffect } from 'react';
import { CheckCircle2, XCircle, Loader2 } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
type QueueItem = {
  id: string;
  url: string;
  status: 'pending' | 'preparing' | 'processing' | 'completed' | 'failed' | 'stopped';
  progress?: number;
  filename?: string;
  error?: string;
  format: 'video' | 'audio' | 'texto';
  quality: 'standard' | 'max';
};

function App() {
  const [linksText, setLinksText] = useState('');
  const [destination, setDestination] = useState<string | null>(() => localStorage.getItem('last_destination'));
  const [format, setFormat] = useState<'video' | 'audio' | 'texto'>('video');
  const [quality, setQuality] = useState<'standard' | 'max'>('standard');
  const [isProcessing, setIsProcessing] = useState(false);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [globalStatus, setGlobalStatus] = useState<'idle' | 'preparing' | 'processing' | 'done' | 'error' | 'stopped'>('idle');

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    
    const setupListener = async () => {
      unlisten = await listen<any>('download-progress', (event) => {
        const payload = event.payload;
        setQueue((current) => {
          const newQueue = current.map((item) => 
            item.id === payload.id 
              ? { ...item, status: payload.status, error: payload.error, filename: payload.filename || item.filename, progress: payload.progress ?? item.progress }
              : item
          );
          
          // Check if all are done
          const allDone = newQueue.length > 0 && newQueue.every(q => q.status === 'completed' || q.status === 'failed' || q.status === 'stopped');
          if (allDone) {
            setGlobalStatus('done');
            setIsProcessing(false);
          } else {
            setGlobalStatus('preparing');
            setIsProcessing(true);
          }
          
          return newQueue;
        });
      });
    };

    setupListener();

    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  const handleChooseFolder = async () => {
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        title: 'Escolher pasta de destino'
      });
      if (selected) {
        const dest = selected as string;
        setDestination(dest);
        localStorage.setItem('last_destination', dest);
      }
    } catch (err) {
      console.error('Failed to open dialog', err);
    }
  };

  const handleStart = () => {
    if (!linksText.trim() || !destination) return;
    
    // Parse links from text
    const links = linksText.split('\n').map(l => l.trim()).filter(l => l.length > 0);

    // Filter out duplicates (same URL, format and quality)
    const newLinks = links.filter(url => 
      !queue.some(q => q.url === url && q.format === format && q.quality === quality)
    );

    if (newLinks.length === 0) {
      alert('Os links inseridos já estão na fila com este mesmo formato e qualidade.');
      return;
    }
    
    // Create new queue items
    const newQueue: QueueItem[] = newLinks.map(url => ({
      id: crypto.randomUUID(),
      url,
      status: 'pending',
      format,
      quality
    }));

    setQueue(prev => [...prev, ...newQueue]);
    setLinksText(''); // Clear input

    // Process new items concurrently without blocking
    newQueue.forEach(async (item) => {
      setQueue(prev => prev.map(q => q.id === item.id ? { ...q, status: 'processing' } : q));
      try {
        await invoke('start_download', { 
          id: item.id,
          url: item.url,
          destination,
          format: item.format,
          quality: item.quality
        });
      } catch (err) {
        console.error("Erro ao iniciar download", err);
        setQueue(prev => prev.map(q => q.id === item.id ? { ...q, status: 'failed', error: String(err) } : q));
      }
    });
  };

  const handleStopAll = async () => {
    try {
      await invoke('stop_all_downloads');
      setQueue(prev => prev.map(item => 
        item.status === 'processing' || item.status === 'pending' || item.status === 'preparing'
          ? { ...item, status: 'stopped' } 
          : item
      ));
      setGlobalStatus('idle');
      setIsProcessing(false);
    } catch (err) {
      console.error("Erro ao parar", err);
    }
  };

  const handleStopItem = async (id: string) => {
    try {
      await invoke('stop_download', { id });
      setQueue(prev => prev.map(item => 
        item.id === id ? { ...item, status: 'stopped' } : item
      ));
    } catch (err) {
      console.error("Erro ao parar item", err);
    }
  };

  const handleCancelItem = (id: string) => {
    setQueue(prev => prev.filter(item => item.id !== id));
  };

  const handleResumeItem = async (item: QueueItem) => {
    if (!destination) return;
    
    setQueue(prev => prev.map(q => q.id === item.id ? { ...q, status: 'processing', error: undefined } : q));
    
    try {
      await invoke('start_download', { 
        id: item.id,
        url: item.url,
        destination,
        format: item.format,
        quality: item.quality
      });
    } catch (err) {
      console.error("Erro ao retomar", err);
      setQueue(prev => prev.map(q => q.id === item.id ? { ...q, status: 'failed', error: String(err) } : q));
    }
  };

  const handleResumeAll = () => {
    const toResume = queue.filter(q => q.status === 'stopped' || q.status === 'failed' || q.status === 'pending');
    toResume.forEach(item => handleResumeItem(item));
  };

  const handleClear = () => {
    setQueue(prev => prev.filter(q => q.status === 'processing' || q.status === 'preparing'));
  };

  return (
    <div className="min-h-screen bg-[var(--background)] text-[var(--text-primary)] font-sans flex flex-col p-6 animate-pulso-mount selection:bg-white/20">
      
      {/* TopBar */}
      <header className="flex flex-col mb-10 pt-4 select-none">
        <h1 className="text-2xl font-medium tracking-[0.3em] text-[var(--text-secondary)]">
          <span className="lowercase">[ grab ]</span> 
          <span className="text-sm opacity-70 tracking-[0.2em] ml-3 font-normal lowercase">by <span className="uppercase font-medium tracking-[0.3em]">PULSO</span></span>
          <span className="block text-xs mt-3 opacity-50 tracking-[0.2em] lowercase">download de vídeos e áudios</span>
        </h1>
      </header>

      {/* Main Content */}
      <main className="flex-1 flex flex-col gap-6 max-w-3xl w-full mx-auto pb-12">
        
        {/* Format & Quality Selector Tabs */}
        <div className="flex items-center justify-between mb-2 select-none">
          <div className="flex gap-4">
            <button 
              onClick={() => setFormat('video')}
              className={`text-[11px] font-medium tracking-[0.2em] transition-all lowercase ${format === 'video' ? 'text-glow' : 'text-[var(--text-muted)] hover:text-white'}`}
            >
              [ baixar vídeo ]
            </button>
            <button 
              onClick={() => setFormat('audio')}
              className={`text-[11px] font-medium tracking-[0.2em] transition-all lowercase ${format === 'audio' ? 'text-glow' : 'text-[var(--text-muted)] hover:text-white'}`}
            >
              [ baixar áudio ]
            </button>
            <button 
              onClick={() => setFormat('texto')}
              className={`text-[11px] font-medium tracking-[0.2em] transition-all lowercase ${format === 'texto' ? 'text-glow' : 'text-[var(--text-muted)] hover:text-white'}`}
            >
              [ transcrever ]
            </button>
          </div>
          
          <div className="flex gap-4 items-center">
            <span className="text-[10px] text-[var(--text-muted)] tracking-[0.2em] uppercase opacity-50">qualidade:</span>
            <button 
              onClick={() => setQuality('standard')}
              className={`text-[11px] font-medium tracking-[0.2em] transition-all lowercase ${quality === 'standard' ? 'text-glow' : 'text-[var(--text-muted)] hover:text-white'}`}
            >
              [ padrão ]
            </button>
            <button 
              onClick={() => setQuality('max')}
              className={`text-[11px] font-medium tracking-[0.2em] transition-all lowercase ${quality === 'max' ? 'text-glow' : 'text-[var(--text-muted)] hover:text-white'}`}
              title="Baixa vídeo e áudio sem perdas (pode demorar mais)"
            >
              [ máxima ]
            </button>
          </div>
        </div>

        {/* LinksInputPanel */}
        <section className="border border-white/5 rounded-lg p-[1px] transition-all duration-300">
          <div className="bg-black/50 rounded-lg p-5 h-full">
            <label htmlFor="links" className="block text-[11px] font-medium text-[var(--text-secondary)] mb-4 tracking-[0.2em] lowercase select-none">
              [ links ]
            </label>
            <textarea
              id="links"
              value={linksText}
              onChange={(e) => setLinksText(e.target.value)}
              className="w-full h-40 bg-transparent border-none outline-none resize-none text-[13px] leading-relaxed text-[var(--text-primary)] placeholder:text-white/20 placeholder:leading-relaxed font-mono"
              placeholder={`cole seus links de vídeos, áudios ou playlists completas aqui (um por linha)...
suporta youtube, instagram, tiktok, e vários outros.

o arquivo será baixado como [ ${format} ] na qualidade [ ${quality === 'max' ? 'máxima' : 'padrão'} ].`}
            />
          </div>
        </section>

        {/* DestinationPicker */}
        <section className="border border-white/5 rounded-lg p-[1px] transition-all duration-300">
          <div className="bg-black/50 rounded-lg p-5 flex items-center justify-between gap-4">
            <div className="flex-1 overflow-hidden">
              <span className="block text-[11px] font-medium text-[var(--text-secondary)] mb-2 tracking-[0.2em] lowercase select-none">
                [ destino ]
              </span>
              <span className={`text-[13px] font-mono lowercase truncate ${destination ? 'text-[var(--text-primary)]' : 'text-[var(--text-muted)]'}`}>
                {destination || 'nenhuma pasta selecionada'}
              </span>
            </div>
            <button
              onClick={handleChooseFolder}
              disabled={isProcessing}
              className="px-4 py-2 hover:bg-white/5 border border-transparent hover:border-white/10 rounded-md text-[11px] font-medium tracking-[0.1em] transition-all active:scale-95 flex items-center gap-2 whitespace-nowrap cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed text-[var(--text-secondary)] hover:text-white lowercase"
            >
              [ selecionar ]
            </button>
          </div>
        </section>

        {/* PrimaryActionBar */}
        <div className="mt-4 flex justify-end gap-3">
          <button
            onClick={handleStart}
            disabled={!linksText.trim() || !destination}
            className="px-8 py-3 bg-transparent hover:bg-white/5 border border-white/10 hover:border-glow rounded-lg text-[12px] font-medium tracking-[0.2em] text-[var(--text-secondary)] hover:text-glow flex items-center gap-3 transition-all disabled:opacity-40 disabled:pointer-events-none active:scale-95 cursor-pointer lowercase"
          >
            {queue.some(q => q.status === 'processing' || q.status === 'preparing') ? '[ incluir na fila ]' : '[ baixar ]'}
          </button>
        </div>

        {/* ProgressPanel & QueueList (Conditional) */}
        {queue.length > 0 && (
          <div className="mt-8 p-6 rounded-2xl glass-interactive animate-pulso-mount min-h-[160px] flex flex-col">
            <div className="flex items-center justify-between mb-4">
              <span className="text-[11px] font-medium text-[var(--text-secondary)] tracking-[0.2em] lowercase select-none">
                [ progresso ]
              </span>
              <div className="flex items-center gap-4">
                {globalStatus === 'preparing' && <span className="text-[11px] text-glow font-medium tracking-wide flex items-center gap-2"><Loader2 size={12} className="animate-spin" /> processando</span>}
                <div className="flex items-center gap-3">
                  <button onClick={handleResumeAll} className="text-[10px] text-[var(--text-muted)] hover:text-white transition-colors cursor-pointer lowercase tracking-widest">[ retomar tudo ]</button>
                  <button onClick={handleStopAll} className="text-[10px] text-[var(--text-muted)] hover:text-rose-400 transition-colors cursor-pointer lowercase tracking-widest">[ parar tudo ]</button>
                  <button onClick={handleClear} className="text-[10px] text-[var(--text-muted)] hover:text-white transition-colors cursor-pointer lowercase tracking-widest">[ limpar ]</button>
                </div>
                <span className="text-[11px] font-mono text-[var(--text-muted)] tracking-widest">
                  [ {queue.filter(q => q.status === 'completed').length} / {queue.length} ]
                </span>
              </div>
            </div>

              <div className="space-y-2 max-h-60 overflow-y-auto pr-3 custom-scrollbar">
                {queue.map((item) => (
                  <div key={item.id} className="flex flex-col gap-1.5 p-3.5 rounded-xl bg-white/[0.03] border border-white/5 hover:bg-white/[0.05] transition-colors">
                    <div className="flex items-center justify-between">
                      <div className="flex-1 min-w-0">
                        <p className="text-[13px] font-mono truncate text-[var(--text-primary)] opacity-80 mb-1.5">{item.filename || item.url}</p>
                        <div className="flex items-center gap-3">
                          <span className={`text-[10px] tracking-[0.1em] px-2 py-0.5 rounded-sm lowercase font-medium ${item.status === 'processing' ? 'bg-white/10 text-white' : 'bg-white/5 text-[var(--text-muted)]'}`}>
                            [ {item.format} • {item.quality === 'max' ? 'máxima' : 'padrão'} ]
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 text-[13px] font-medium tracking-wide lowercase">
                        {item.status === 'pending' && <span className="text-[var(--text-muted)]">pendente</span>}
                        {item.status === 'stopped' && <span className="text-[var(--text-muted)]">interrompido</span>}
                        {item.status === 'processing' && (
                          <span className="text-glow flex items-center gap-2">
                            <Loader2 size={14} className="animate-spin" /> {item.progress ? `${item.progress.toFixed(1)}%` : 'processando'}
                          </span>
                        )}
                        {item.status === 'completed' && (
                          <div className="flex items-center gap-3">
                            <span className="text-glow flex items-center gap-2">
                              <CheckCircle2 size={14} /> concluído
                            </span>
                            <button
                              onClick={async () => {
                                if (item.filename && destination) {
                                  await invoke('reveal_in_finder', { path: `${destination}/${item.filename}` });
                                } else if (destination) {
                                  await invoke('reveal_in_finder', { path: destination });
                                }
                              }}
                              className="text-[10px] text-[var(--text-muted)] hover:text-white border border-white/10 hover:border-white/30 px-2 py-0.5 rounded transition-all cursor-pointer"
                            >
                              [ abrir ]
                            </button>
                          </div>
                        )}
                        {item.status === 'failed' && (
                          <span className="text-rose-400 flex items-center gap-2" title={item.error}>
                            <XCircle size={14} /> falhou
                          </span>
                        )}

                        {/* Controles individuais */}
                        <div className="ml-2 flex items-center gap-2 border-l border-white/10 pl-3">
                          {item.status === 'processing' && (
                            <button onClick={() => handleStopItem(item.id)} className="text-[10px] text-[var(--text-muted)] hover:text-rose-400 cursor-pointer transition-colors">[ parar ]</button>
                          )}
                          {(item.status === 'stopped' || item.status === 'failed' || item.status === 'pending') && (
                            <button onClick={() => handleResumeItem(item)} className="text-[10px] text-[var(--text-muted)] hover:text-white cursor-pointer transition-colors">[ continuar ]</button>
                          )}
                          {item.status !== 'processing' && item.status !== 'completed' && (
                            <button onClick={() => handleCancelItem(item.id)} className="text-[10px] text-[var(--text-muted)] hover:text-rose-400 cursor-pointer transition-colors">[ cancelar ]</button>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              
              {/* Summary Block */}
              {(globalStatus === 'done' || globalStatus === 'stopped') && (
                <div className="mt-6 pt-5 border-t border-white/10 flex items-center justify-between animate-pulso-mount">
                  <div className="lowercase">
                    <p className="text-sm font-medium text-white tracking-wide">processo finalizado</p>
                    <p className="text-xs mt-1.5 flex gap-3">
                      <span className={queue.filter(q => q.status === 'completed').length > 0 ? "text-glow/80" : "text-[var(--text-muted)]"}>
                        {queue.filter(q => q.status === 'completed').length} concluídos
                      </span>
                      <span className={queue.filter(q => q.status === 'failed' || q.status === 'stopped').length > 0 ? "text-rose-400/80" : "text-[var(--text-muted)]"}>
                        {queue.filter(q => q.status === 'failed' || q.status === 'stopped').length} interrompidos/falhas
                      </span>
                    </p>
                  </div>
                </div>
              )}

            </div>
        )}

      </main>
    </div>
  );
}

export default App;
