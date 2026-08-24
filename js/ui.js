/**
 * Chipless Poker – UI Layer
 * Manages screens, pass-the-device flow, and renders state from the Game model.
 */

const SCREENS = {
  SETUP: 'setup',
  PASS: 'pass',
  ACTION: 'action',
  ROUND_END: 'round-end',
  SHOWDOWN: 'showdown',
  SUMMARY: 'summary',
  HISTORY: 'history'
};

class UI {
  constructor(game) {
    this.game = game;
    this.currentScreen = SCREENS.SETUP;
    this.selectedWinners = {}; // potIndex -> Set of playerIds
    this.raiseInputValue = null;
  }

  /** Entry point – call after DOM ready */
  init() {
    this.bindGlobalEvents();
    this.showScreen(SCREENS.SETUP);
    this.renderSetup();
  }

  bindGlobalEvents() {
    // Nothing global yet – most listeners are attached per-render
  }

  showScreen(name) {
    document.querySelectorAll('.screen').forEach(el => el.classList.add('hidden'));
    const el = document.getElementById(`screen-${name}`);
    if (el) {
      el.classList.remove('hidden');
      this.currentScreen = name;
    }
  }

  // ---------- SETUP ----------
  renderSetup() {
    const container = document.getElementById('setup-players');
    if (!container) return;

    // Default 4 players
    if (container.children.length === 0) {
      for (let i = 0; i < 4; i++) {
        this.addPlayerRow(container, i + 1, `Player ${i + 1}`, 1000);
      }
    }
  }

  addPlayerRow(container, num, name, stack) {
    const row = document.createElement('div');
    row.className = 'player-setup-row';
    row.innerHTML = `
      <input type="text" class="player-name" value="${name}" placeholder="Name" maxlength="16">
      <input type="number" class="player-stack" value="${stack}" min="1" step="1">
      <button type="button" class="btn-icon remove-player" title="Remove">✕</button>
    `;
    row.querySelector('.remove-player').addEventListener('click', () => {
      if (container.children.length > 2) row.remove();
    });
    container.appendChild(row);
  }

  startGameFromSetup() {
    const nameInputs = document.querySelectorAll('.player-name');
    const stackInputs = document.querySelectorAll('.player-stack');
    const players = [];
    nameInputs.forEach((inp, i) => {
      const name = inp.value.trim() || `Player ${i + 1}`;
      const stack = parseInt(stackInputs[i].value, 10) || 1000;
      players.push({ name, stack });
    });

    if (players.length < 2) {
      alert('Need at least 2 players');
      return;
    }

    const sb = parseInt(document.getElementById('cfg-sb').value, 10) || 5;
    const bb = parseInt(document.getElementById('cfg-bb').value, 10) || 10;
    const ante = parseInt(document.getElementById('cfg-ante').value, 10) || 0;

    // Create new Game
    this.game = new Game({
      players,
      smallBlind: sb,
      bigBlind: bb,
      ante
    });

    // Kick off first hand
    this.beginHand();
  }

  // ---------- HAND FLOW ----------
  beginHand() {
    try {
      const info = this.game.startNewHand();
      if (info.goToShowdown || this.game.pendingShowdown || this.game.shouldGoToShowdown()) {
        this.renderShowdown();
        this.showScreen(SCREENS.SHOWDOWN);
        return;
      }
      this.showPassScreen(info.firstToAct);
    } catch (e) {
      console.error(e);
      alert('Error starting hand: ' + e.message);
    }
  }

  showPassScreen(player) {
    this.showScreen(SCREENS.PASS);
    const el = document.getElementById('pass-player-name');
    const sub = document.getElementById('pass-sub');
    if (el) el.textContent = player.name;
    if (sub) {
      sub.textContent = `Hand #${this.game.handNumber} · ${this.game.stage.toUpperCase()}`;
    }
  }

  onPassConfirmed() {
    this.renderActionScreen();
    this.showScreen(SCREENS.ACTION);
  }

  // ---------- ACTION SCREEN ----------
  renderActionScreen() {
    const state = this.game.getPublicState();
    const me = state.players[state.currentPlayerIndex];
    if (!me) return;

    // Safety net: never show action UI for a player who cannot act
    if (me.folded || me.allIn || this.game.shouldGoToShowdown()) {
      this.game.stage = 'showdown';
      this.game.pendingShowdown = true;
      this.renderShowdown();
      this.showScreen(SCREENS.SHOWDOWN);
      return;
    }

    // Header
    document.getElementById('action-player-name').textContent = me.name;
    document.getElementById('action-stage').textContent = state.stage.toUpperCase();
    document.getElementById('action-hand-num').textContent = `Hand #${state.handNumber}`;

    // Stacks strip (public info)
    const stacksEl = document.getElementById('stacks-strip');
    stacksEl.innerHTML = state.players.map(p => {
      let cls = 'stack-chip';
      if (p.folded) cls += ' folded';
      if (p.allIn) cls += ' allin';
      if (p.id === me.id) cls += ' current';
      if (p.isDealer) cls += ' dealer';
      return `<div class="${cls}" title="${p.name}">
        <span class="s-name">${this.escape(p.name)}</span>
        <span class="s-stack">${p.stack}</span>
        ${p.betThisRound > 0 ? `<span class="s-bet">${p.betThisRound}</span>` : ''}
      </div>`;
    }).join('');

    // Pot & current bet
    document.getElementById('pot-display').textContent = state.totalPot;
    document.getElementById('current-bet-display').textContent = state.currentBet;

    // To-call info
    const toCall = Math.max(0, state.currentBet - me.betThisRound);
    const toCallEl = document.getElementById('to-call-amount');
    toCallEl.textContent = toCall;
    toCallEl.parentElement.style.display = toCall > 0 ? 'block' : 'none';

    // Action buttons
    this.renderActionButtons(me, state, toCall);

    // Live remaining preview for raise/bet
    this.updateRaisePreview(me);
  }

  renderActionButtons(me, state, toCall) {
    const container = document.getElementById('action-buttons');
    container.innerHTML = '';

    const btn = (label, action, extraClass = '', disabled = false) => {
      const b = document.createElement('button');
      b.className = `btn action-btn ${extraClass}`;
      b.textContent = label;
      b.disabled = disabled;
      b.addEventListener('click', () => this.handleAction(action));
      container.appendChild(b);
      return b;
    };

    // Fold always available (unless already all-in which shouldn't happen)
    btn('Fold', 'fold', 'btn-fold');

    if (toCall === 0) {
      btn('Check', 'check', 'btn-check');
    } else {
      const callLabel = me.stack <= toCall ? `All-in ${me.stack}` : `Call ${toCall}`;
      btn(callLabel, me.stack <= toCall ? 'all-in' : 'call', 'btn-call');
    }

    // Bet or Raise
    if (state.currentBet === 0) {
      btn('Bet', 'bet', 'btn-bet');
    } else {
      btn('Raise', 'raise', 'btn-raise');
    }

    btn('All-in', 'all-in', 'btn-allin');

    // Amount controls for bet/raise
    const amountPanel = document.getElementById('amount-panel');
    amountPanel.classList.remove('hidden');

    // Quick amounts
    const quick = document.getElementById('quick-amounts');
    quick.innerHTML = '';
    const pot = state.totalPot || state.currentBet || this.game.config.bigBlind;
    const suggestions = [
      { label: 'Min', value: state.currentBet === 0 ? this.game.config.bigBlind : state.currentBet + state.lastRaiseSize },
      { label: '½ Pot', value: Math.floor(pot / 2) },
      { label: '¾ Pot', value: Math.floor(pot * 0.75) },
      { label: 'Pot', value: pot },
      { label: 'All-in', value: me.stack + me.betThisRound }
    ];

    suggestions.forEach(s => {
      if (s.value <= 0) return;
      const b = document.createElement('button');
      b.className = 'btn btn-quick';
      b.textContent = s.label;
      b.addEventListener('click', () => {
        document.getElementById('raise-input').value = s.value;
        this.raiseInputValue = s.value;
        this.updateRaisePreview(me);
      });
      quick.appendChild(b);
    });

    // Input
    const input = document.getElementById('raise-input');
    input.value = state.currentBet === 0 ? this.game.config.bigBlind : state.currentBet + state.lastRaiseSize;
    input.min = 1;
    input.max = me.stack + me.betThisRound;
    input.oninput = () => {
      this.raiseInputValue = parseInt(input.value, 10) || 0;
      this.updateRaisePreview(me);
    };
  }

  updateRaisePreview(me) {
    const input = document.getElementById('raise-input');
    const val = parseInt(input.value, 10) || 0;
    const needed = Math.max(0, val - me.betThisRound);
    const remaining = me.stack - needed;
    const preview = document.getElementById('raise-preview');
    if (preview) {
      preview.textContent = remaining >= 0
        ? `You will have ${remaining} left`
        : `Not enough chips (need ${needed})`;
      preview.className = remaining >= 0 ? 'preview-ok' : 'preview-bad';
    }
  }

  handleAction(action) {
    const me = this.game.players[this.game.currentPlayerIndex];
    let raiseTo = null;

    if (action === 'bet' || action === 'raise') {
      const input = document.getElementById('raise-input');
      raiseTo = parseInt(input.value, 10);
      if (isNaN(raiseTo) || raiseTo <= 0) {
        alert('Enter a valid amount');
        return;
      }
    }

    const result = this.game.performAction(me.id, action, raiseTo);

    if (!result.success) {
      alert(result.message);
      return;
    }

    // Feedback
    this.showToast(result.message);

    if (result.goToShowdown || this.game.pendingShowdown || this.game.shouldGoToShowdown()) {
      // Everyone all-in, or only one player left in hand
      this.game.stage = 'showdown';
      this.game.pendingShowdown = true;
      this.renderShowdown();
      this.showScreen(SCREENS.SHOWDOWN);
      return;
    }

    if (result.roundOver) {
      this.renderRoundEnd();
      this.showScreen(SCREENS.ROUND_END);
    } else {
      // Pass to next player who can act
      this.showPassScreen(result.nextPlayer);
    }
  }

  // ---------- ROUND END (advance street) ----------
  renderRoundEnd() {
    const state = this.game.getPublicState();
    document.getElementById('round-end-stage').textContent = state.stage.toUpperCase();
    document.getElementById('round-end-pot').textContent = state.totalPot;

    const nextLabel = {
      preflop: 'Deal Flop',
      flop: 'Deal Turn',
      turn: 'Deal River',
      river: 'Go to Showdown'
    }[state.stage] || 'Continue';

    const btn = document.getElementById('btn-advance-stage');
    btn.textContent = nextLabel;
  }

  onAdvanceStage() {
    const ok = this.game.advanceStage();
    if (!ok) return;

    if (this.game.stage === 'showdown' || this.game.pendingShowdown || this.game.shouldGoToShowdown()) {
      this.game.stage = 'showdown';
      this.game.pendingShowdown = true;
      this.renderShowdown();
      this.showScreen(SCREENS.SHOWDOWN);
    } else {
      // New betting round – pass to first actor who can still act
      const first = this.game.players[this.game.currentPlayerIndex];
      if (!first || first.folded || first.allIn) {
        // Defensive: should not happen after advanceStage, but never show action UI for all-in
        this.game.stage = 'showdown';
        this.game.pendingShowdown = true;
        this.renderShowdown();
        this.showScreen(SCREENS.SHOWDOWN);
        return;
      }
      this.showPassScreen(first);
    }
  }

  // ---------- SHOWDOWN ----------
  renderShowdown() {
    this.selectedWinners = {};
    const state = this.game.getPublicState();
    const container = document.getElementById('showdown-pots');
    container.innerHTML = '';

    if (state.pots.length === 0) {
      container.innerHTML = '<p>No pots to distribute.</p>';
      return;
    }

    state.pots.forEach((pot, idx) => {
      this.selectedWinners[idx] = new Set();

      const card = document.createElement('div');
      card.className = 'pot-card';
      card.innerHTML = `
        <div class="pot-header">
          <span class="pot-label">Pot ${idx + 1}</span>
          <span class="pot-amount">${pot.amount}</span>
        </div>
        <div class="pot-eligible">Eligible: ${pot.eligible.map(id => {
          const p = state.players.find(pl => pl.id === id);
          return p ? this.escape(p.name) : id;
        }).join(', ')}</div>
        <div class="winner-select" data-pot="${idx}"></div>
      `;

      const selectDiv = card.querySelector('.winner-select');
      pot.eligible.forEach(id => {
        const p = state.players.find(pl => pl.id === id);
        if (!p) return;
        const label = document.createElement('label');
        label.className = 'winner-chip';
        label.innerHTML = `
          <input type="checkbox" data-pot="${idx}" data-id="${id}">
          <span>${this.escape(p.name)}</span>
        `;
        label.querySelector('input').addEventListener('change', (e) => {
          if (e.target.checked) this.selectedWinners[idx].add(id);
          else this.selectedWinners[idx].delete(id);
        });
        selectDiv.appendChild(label);
      });

      container.appendChild(card);
    });
  }

  onDistribute() {
    const winnersPerPot = Object.keys(this.selectedWinners).map(idx => ({
      potIndex: parseInt(idx, 10),
      winnerIds: [...this.selectedWinners[idx]]
    }));

    // Basic validation
    for (const w of winnersPerPot) {
      if (w.winnerIds.length === 0) {
        alert(`Select at least one winner for Pot ${w.potIndex + 1}`);
        return;
      }
    }

    try {
      const results = this.game.distributePots(winnersPerPot);
      this.renderSummary(results);
      this.showScreen(SCREENS.SUMMARY);
    } catch (e) {
      alert(e.message);
    }
  }

  renderSummary(results) {
    const el = document.getElementById('summary-content');
    const state = this.game.getPublicState();

    let html = `<h3>Hand #${state.handNumber} Results</h3>`;
    html += '<ul class="payout-list">';
    results.forEach(r => {
      if (r.error) html += `<li class="error">${r.error}</li>`;
      else html += `<li><strong>${this.escape(r.name)}</strong> wins ${r.amount} from Pot ${r.potIndex + 1}</li>`;
    });
    html += '</ul>';

    html += '<h4>Stacks after hand</h4><div class="stacks-after">';
    state.players.forEach(p => {
      html += `<div class="stack-chip"><span class="s-name">${this.escape(p.name)}</span><span class="s-stack">${p.stack}</span></div>`;
    });
    html += '</div>';

    el.innerHTML = html;
  }

  onNextHand() {
    this.beginHand();
  }

  // ---------- HISTORY ----------
  showHistory() {
    const el = document.getElementById('history-list');
    if (!this.game || this.game.handHistory.length === 0) {
      el.innerHTML = '<p class="muted">No hands completed yet.</p>';
    } else {
      el.innerHTML = this.game.handHistory.map(h => {
        const winners = h.results
          .filter(r => !r.error)
          .map(r => `${this.escape(r.name)} +${r.amount}`)
          .join(', ');
        return `<div class="history-item">
          <div class="h-num">Hand #${h.handNumber}</div>
          <div class="h-winners">${winners || '—'}</div>
        </div>`;
      }).reverse().join('');
    }
    this.showScreen(SCREENS.HISTORY);
  }

  // ---------- HELPERS ----------
  showToast(msg) {
    const t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 2200);
  }

  escape(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }
}

// Export
if (typeof window !== 'undefined') {
  window.UI = UI;
  window.SCREENS = SCREENS;
}
