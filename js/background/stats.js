'use strict';
/**
 * SandBlock — Historique des blocages
 *
 * Agrège, jour par jour, le nombre de requêtes bloquées et les domaines
 * les plus fréquents. Tout reste sur l'appareil : rien n'est transmis,
 * la déclaration « aucune collecte » est intacte.
 *
 * CONTRAINTE DE CONCEPTION — `bump()` est appelé sur le chemin critique du
 * filtrage. Il ne fait donc qu'incrémenter une Map en mémoire : ni date,
 * ni allocation, ni accès au stockage. Le basculement de journée et
 * l'écriture disque se font sur minuterie, toutes les 30 secondes. Une
 * poignée de requêtes peut être attribuée à la veille juste après minuit ;
 * c'est sans conséquence et ça évite un `new Date()` par blocage.
 *
 * CE QUI N'EST DÉLIBÉRÉMENT PAS MESURÉ : les « données économisées » et le
 * « temps de chargement gagné ». Une requête bloquée n'est jamais
 * téléchargée, donc sa taille est inconnue — tout chiffre affiché serait
 * une invention présentée comme une mesure. uBlock Origin ne les montre
 * pas davantage.
 */

(function () {

const SB = (self.SB = self.SB || {});

const KEY = 'stats:daily';
const DAYS = 30;              // fenêtre glissante
const TOP_PERSISTED = 50;     // domaines conservés par jour sur disque
const MAX_DOMAINS_MEMORY = 2000;
const FLUSH_MS = 30000;

const st = {
  day: '',                 // 'AAAA-MM-JJ' de la journée en cours
  total: 0,                // blocages de la journée, en mémoire
  domains: new Map(),      // domaine -> compteur, journée en cours
  history: Object.create(null), // 'AAAA-MM-JJ' -> { total, top }
  timer: null,
  loaded: false,
};

/** Date locale : l'utilisateur veut voir SA journée, pas celle d'UTC. */
function dayKey(d) {
  const date = d || new Date();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${m}-${day}`;
}

/**
 * Incrémenté à chaque blocage. Volontairement minimal.
 * @param {string} hostname domaine de la requête bloquée
 */
function bump(hostname) {
  st.total++;
  if (hostname !== '') {
    const n = st.domains.get(hostname);
    if (n !== undefined) {
      st.domains.set(hostname, n + 1);
    } else if (st.domains.size < MAX_DOMAINS_MEMORY) {
      st.domains.set(hostname, 1);
    }
  }
  if (st.timer === null) {
    st.timer = setTimeout(() => { st.timer = null; flush(); }, FLUSH_MS);
  }
}

/** Les N domaines les plus bloqués, sous forme d'objet sérialisable. */
function topOf(map, limit) {
  const sorted = [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
  // Sans prototype : les clés sont des noms d'hôtes venus du réseau, et
  // rien ne garantit qu'aucun ne s'appelle « __proto__ ».
  const out = Object.create(null);
  for (const [domain, count] of sorted) out[domain] = count;
  return out;
}

/** Retire les journées sorties de la fenêtre. */
function prune() {
  const keys = Object.keys(st.history).sort();
  while (keys.length > DAYS) {
    delete st.history[keys.shift()];
  }
}

async function flush() {
  if (!st.loaded) return;
  const now = dayKey();

  if (st.day !== '' && st.day !== now) {
    // Changement de journée : on fige la précédente et on repart à zéro.
    st.history[st.day] = { total: st.total, top: topOf(st.domains, TOP_PERSISTED) };
    st.total = 0;
    st.domains.clear();
  }
  st.day = now;
  st.history[now] = { total: st.total, top: topOf(st.domains, TOP_PERSISTED) };
  prune();

  try {
    await browser.storage.local.set({ [KEY]: st.history });
  } catch (_) {
    // Stockage indisponible : les compteurs restent en mémoire.
  }
}

async function init() {
  try {
    const stored = await browser.storage.local.get(KEY);
    const history = stored[KEY];
    if (history !== undefined && history !== null && typeof history === 'object') {
      st.history = Object.assign(Object.create(null), history);
    }
  } catch (_) {}

  st.day = dayKey();
  // Reprendre la journée en cours si le navigateur a redémarré.
  //
  // On ADDITIONNE au lieu d'affecter : les écouteurs webRequest sont
  // déjà en place quand init() s'exécute, donc des blocages ont pu être
  // comptés pendant la lecture du stockage. Une affectation les perdrait.
  const today = st.history[st.day];
  if (today !== undefined) {
    st.total += today.total || 0;
    for (const [domain, count] of Object.entries(today.top || {})) {
      st.domains.set(domain, (st.domains.get(domain) || 0) + count);
    }
  }
  st.loaded = true;
  prune();
}

/**
 * Vue destinée à l'interface : les 30 derniers jours, du plus ancien au
 * plus récent, et le classement des domaines sur la période.
 */
function snapshot() {
  const merged = Object.assign(Object.create(null), st.history);
  const now = dayKey();
  merged[now] = { total: st.total, top: topOf(st.domains, TOP_PERSISTED) };

  const days = [];
  const cursor = new Date();
  cursor.setHours(12, 0, 0, 0); // midi : à l'abri des changements d'heure
  for (let i = DAYS - 1; i >= 0; i--) {
    const d = new Date(cursor.getTime() - i * 86400000);
    const key = dayKey(d);
    days.push({ date: key, total: (merged[key] && merged[key].total) || 0 });
  }

  const totals = new Map();
  for (const entry of Object.values(merged)) {
    for (const [domain, count] of Object.entries(entry.top || {})) {
      totals.set(domain, (totals.get(domain) || 0) + count);
    }
  }
  const top = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);

  return {
    days,
    top,
    today: st.total,
    period: days.reduce((sum, d) => sum + d.total, 0),
  };
}

async function clear() {
  st.total = 0;
  st.domains.clear();
  st.history = Object.create(null);
  st.day = dayKey();
  try { await browser.storage.local.remove(KEY); } catch (_) {}
}

SB.stats = { init, bump, snapshot, clear, flush };

})();
