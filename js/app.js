/**
 * Chipless Poker – Application entry point
 * Wires the UI to the Game model and handles all DOM events.
 */

(function () {
  'use strict';

  let ui = null;
  let game = null; // will be created on Start Game

  function ready(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  ready(() => {
    // Temporary placeholder Game so UI can exist before real start
    game = new Game({
      players: [
        { name: 'Alice', stack: 1000 },
        { name: 'Bob', stack: 1000 },
        { name: 'Carol', stack: 1000 },
        { name: 'Dave', stack: 1000 }
      ],
      smallBlind: 5,
      bigBlind: 10,
      ante: 0
    });

    ui = new UI(game);
    ui.init();

    // ---- Event bindings ----
    document.getElementById('btn-add-player')?.addEventListener('click', () => {
      const container = document.getElementById('setup-players');
      const count = container.children.length + 1;
      ui.addPlayerRow(container, count, `Player ${count}`, 1000);
    });

    document.getElementById('btn-start-game')?.addEventListener('click', () => {
      ui.startGameFromSetup();
    });

    document.getElementById('btn-pass-confirm')?.addEventListener('click', () => {
      ui.onPassConfirmed();
    });

    document.getElementById('btn-advance-stage')?.addEventListener('click', () => {
      ui.onAdvanceStage();
    });

    document.getElementById('btn-distribute')?.addEventListener('click', () => {
      ui.onDistribute();
    });

    document.getElementById('btn-next-hand')?.addEventListener('click', () => {
      ui.onNextHand();
    });

    // History buttons (multiple places)
    ['btn-history-action', 'btn-history-round', 'btn-history-summary'].forEach(id => {
      document.getElementById(id)?.addEventListener('click', () => ui.showHistory());
    });

    document.getElementById('btn-history-back')?.addEventListener('click', () => {
      // Return to the most relevant previous screen
      if (ui.game.stage === 'showdown' || ui.game.pendingShowdown) {
        ui.showScreen(SCREENS.SHOWDOWN);
      } else if (ui.currentScreen === SCREENS.HISTORY) {
        // Heuristic: if we came from action we may not know, default to pass or action
        const alive = ui.game.activePlayers();
        if (alive.length <= 1) {
          ui.renderShowdown();
          ui.showScreen(SCREENS.SHOWDOWN);
        } else {
          // safest is to re-show pass for current player
          const cur = ui.game.players[ui.game.currentPlayerIndex];
          ui.showPassScreen(cur);
        }
      }
    });

    console.log('Chipless Poker ready. Total chips invariant enforced on every action.');
  });
})();
