/**
 * script.js
 *
 * Busca as lives AGENDADAS (upcoming) de um ou mais canais do YouTube e filtra
 * apenas as que vão ao ar em uma data específica (horário de Brasília).
 * Gera um arquivo JSON estruturado com os resultados, separado por canal.
 *
 * Uso:
 *   node script.js                 -> usa a data de hoje
 *   node script.js 2026-08-25       -> usa a data informada (YYYY-MM-DD)
 *
 * Configure a API_KEY e o CHANNEL_IDS abaixo (ou via variáveis de ambiente).
 */

const fs = require('fs');
const path = require('path');

const API_KEY = process.env.YOUTUBE_API_KEY;

// Lista de canais monitorados. Adicione quantos quiser.
// Pode ser configurado via variável de ambiente YT_CHANNEL_IDS separada por vírgula.
const CHANNEL_IDS = process.env.YT_CHANNEL_IDS
  ? process.env.YT_CHANNEL_IDS.split(',').map(id => id.trim()).filter(Boolean)
  : [
      'UCZiYbVptd3PVPf4f6eR6UaQ', // CazéTV
      'UCgCKagVhzGnZcuP9bSMgMCg', // getv
      'UCs-6sCz2LJm1PrWQN4ErsPw', // TNT Sports
      'UCw5-xj3AKqEizC7MvHaIPqA', // ESPN Brasil
      'UC_oToDrJ6uca7d1dFVBmLtg', // Canal GOAT
      'UCv-Nx8pSfG_LxbViMz14RWQ', // Jovem Pan Sports
      'UCf9WJPpsh5BHDY-OeISgIqA', // N Sports
      'UCMcc9elPZGpg6eU4i3YaCpA', // SportyNet
      'UC3KHYFWeB0WimMBfm3NEahQ', // UOL Sports
      'UCH-BU-Os3JSo2L8lBQxE8KA', // XSports
      'UC8RrjoT8ovQ43Le7qvHuoMA', // Metrópoles Esportes
      'UCfi9IhipFGSa0eD_EA8JHrA', // Canal GoLBrasil
    ];

// Data passada como argumento (ex: node script.js 2026-08-25)
const DATA_ARG = process.argv[2]; // formato esperado: YYYY-MM-DD

const BASE_URL = 'https://www.googleapis.com/youtube/v3';
const OUTPUT_DIR = process.env.OUTPUT_DIR || '.';

// --- Busca informações do canal (nome e logo) ---
async function buscarInfoCanal(channelId, apiKey) {
  const url = new URL(`${BASE_URL}/channels`);
  url.searchParams.set('part', 'snippet');
  url.searchParams.set('id', channelId);
  url.searchParams.set('key', apiKey);

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Erro na busca (channels.list): ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  const canal = data.items?.[0];
  if (!canal) {
    throw new Error(`Canal não encontrado: ${channelId}`);
  }

  return {
    nome: canal.snippet.title,
    logo:
      canal.snippet.thumbnails?.high?.url ||
      canal.snippet.thumbnails?.medium?.url ||
      canal.snippet.thumbnails?.default?.url ||
      null,
  };
}

// --- Passo 1: busca os vídeos marcados como "upcoming" no canal ---
async function buscarUpcoming(channelId, apiKey) {
  const url = new URL(`${BASE_URL}/search`);
  url.searchParams.set('part', 'snippet');
  url.searchParams.set('channelId', channelId);
  url.searchParams.set('eventType', 'upcoming');
  url.searchParams.set('type', 'video');
  url.searchParams.set('maxResults', '50');
  url.searchParams.set('regionCode', 'BR');
  url.searchParams.set('hl', 'pt-BR');
  url.searchParams.set('key', apiKey);

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Erro na busca (search.list): ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data.items || [];
}

// --- Passo 2: pega os detalhes reais de agendamento (scheduledStartTime) ---
async function buscarDetalhesVideos(videoIds, apiKey) {
  if (videoIds.length === 0) return [];

  const url = new URL(`${BASE_URL}/videos`);
  url.searchParams.set('part', 'snippet,liveStreamingDetails');
  url.searchParams.set('id', videoIds.join(','));
  url.searchParams.set('key', apiKey);

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Erro na busca (videos.list): ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data.items || [];
}

// --- Helper: valida e parseia uma string YYYY-MM-DD ---
function parsearDataArg(dataStr) {
  const regex = /^(\d{4})-(\d{2})-(\d{2})$/;
  const match = dataStr.match(regex);
  if (!match) {
    throw new Error(`Data inválida: "${dataStr}". Use o formato YYYY-MM-DD (ex: 2026-08-25).`);
  }
  const [, ano, mes, dia] = match.map(Number);
  return { ano, mes: mes, dia };
}

// --- Helper: retorna o início e fim do dia informado (ou hoje), no fuso de Brasília (UTC-3) ---
function getIntervaloDoDiaBrasilia(dataStr) {
  const offsetBrasilia = -3 * 60; // minutos

  let ano, mes, dia;

  if (dataStr) {
    // Usa a data informada pelo usuário
    ({ ano, mes, dia } = parsearDataArg(dataStr));
    mes = mes - 1; // Date usa mês 0-indexado
  } else {
    // Usa a data de hoje, já ajustada para o fuso de Brasília
    const agora = new Date();
    const agoraBrasilia = new Date(agora.getTime() + offsetBrasilia * 60000);
    ano = agoraBrasilia.getUTCFullYear();
    mes = agoraBrasilia.getUTCMonth();
    dia = agoraBrasilia.getUTCDate();
  }

  const inicioBrasilia = new Date(Date.UTC(ano, mes, dia, 0, 0, 0));
  const fimBrasilia = new Date(inicioBrasilia.getTime() + 24 * 60 * 60000);

  // Converte de volta para UTC real (soma 3h) para comparar com scheduledStartTime (que vem em UTC)
  const inicioUTC = new Date(inicioBrasilia.getTime() - offsetBrasilia * 60000);
  const fimUTC = new Date(fimBrasilia.getTime() - offsetBrasilia * 60000);

  return { inicioUTC, fimUTC };
}

// --- Retorna a data-alvo no formato YYYY-MM-DD (para o campo "data" do JSON) ---
function getDataFormatada(dataStr) {
  if (dataStr) return dataStr;
  const { inicioUTC } = getIntervaloDoDiaBrasilia(dataStr);
  // inicioUTC já representa 00:00 de Brasília; extraímos a data em Brasília
  return new Date(inicioUTC.getTime() + 3 * 60 * 60000).toISOString().slice(0, 10);
}

function formatarHorarioBrasilia(isoString) {
  return new Date(isoString).toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// --- Processa um único canal: busca info, upcoming, detalhes e filtra pelo dia ---
async function processarCanal(channelId, apiKey, inicioUTC, fimUTC) {
  const resultado = {
    canalId: channelId,
    nome: null,
    logo: null,
    totalLives: 0,
    lives: [],
    erro: null,
  };

  try {
    const info = await buscarInfoCanal(channelId, apiKey);
    resultado.nome = info.nome;
    resultado.logo = info.logo;

    const resultadosSearch = await buscarUpcoming(channelId, apiKey);
    const videoIds = resultadosSearch
      .filter(item => item.snippet.liveBroadcastContent === 'upcoming')
      .map(item => item.id.videoId);

    if (videoIds.length === 0) {
      return resultado;
    }

    const detalhes = await buscarDetalhesVideos(videoIds, apiKey);

    const doDia = detalhes
      .filter(video => {
        const scheduled = video.liveStreamingDetails?.scheduledStartTime;
        if (!scheduled) return false;
        const data = new Date(scheduled);
        return data >= inicioUTC && data < fimUTC;
      })
      .sort(
        (a, b) =>
          new Date(a.liveStreamingDetails.scheduledStartTime) -
          new Date(b.liveStreamingDetails.scheduledStartTime)
      );

    resultado.lives = doDia.map(video => ({
      videoId: video.id,
      titulo: video.snippet.title,
      thumbnail:
        video.snippet.thumbnails?.high?.url ||
        video.snippet.thumbnails?.medium?.url ||
        video.snippet.thumbnails?.default?.url ||
        null,
      horarioAgendadoUTC: video.liveStreamingDetails.scheduledStartTime,
      horarioBrasilia: formatarHorarioBrasilia(video.liveStreamingDetails.scheduledStartTime),
      link: `https://www.youtube.com/watch?v=${video.id}`,
    }));
    resultado.totalLives = resultado.lives.length;
  } catch (err) {
    resultado.erro = err.message;
  }

  return resultado;
}

async function main() {
  if (!API_KEY) {
    console.error('❌ Variável YOUTUBE_API_KEY não configurada.');
    process.exit(1);
  }

  if (CHANNEL_IDS.length === 0) {
    console.error('❌ Nenhum canal configurado em CHANNEL_IDS.');
    process.exit(1);
  }

  const rotuloData = DATA_ARG || 'hoje';
  console.log(`Buscando transmissões agendadas para: ${rotuloData} (${CHANNEL_IDS.length} canal(is))...\n`);

  const { inicioUTC, fimUTC } = getIntervaloDoDiaBrasilia(DATA_ARG);
  const dataFormatada = getDataFormatada(DATA_ARG);

  const canais = [];
  for (const channelId of CHANNEL_IDS) {
    const resultado = await processarCanal(channelId, API_KEY, inicioUTC, fimUTC);
    canais.push(resultado);

    if (resultado.erro) {
      console.log(`❌ ${channelId}: ${resultado.erro}`);
    } else {
      console.log(`✅ ${resultado.nome}: ${resultado.totalLives} live(s)`);
    }
  }

  const saida = {
    geradoEm: new Date().toISOString(),
    data: dataFormatada,
    canais,
  };

  const nomeArquivo = `lives.json`;
  const caminhoArquivo = path.join(OUTPUT_DIR, nomeArquivo);

  fs.writeFileSync(caminhoArquivo, JSON.stringify(saida, null, 2), 'utf-8');

  console.log(`\n📄 Arquivo gerado: ${caminhoArquivo}`);
}

main().catch(err => {
  console.error('Erro ao executar o script:', err.message);
  process.exit(1);
});
