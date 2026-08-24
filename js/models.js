/**
 * Chipless Poker - Core Data Models
 * Pure data + chip movement primitives. No UI.
 * Every chip movement goes through these methods so the total-chip invariant can be checked.
 */

class Player {
  constructor(id, name, stack) {
    this.id = id;
    this.name = name;
    this.stack = stack;                 // current chips
    this.betThisRound = 0;              // chips put in during current betting round
    this.totalContributed = 0;          // chips put in during this entire hand
    this.folded = false;
    this.allIn = false;
    this.seatIndex = id;                // 0-based seating order
  }

  resetForNewHand() {
    this.betThisRound = 0;
    this.totalContributed = 0;
    this.folded = false;
    this.allIn = false;
  }

  /** Move chips from stack into the pot system. Returns actual amount moved. */
  contribute(amount) {
    if (amount < 0) throw new Error('Cannot contribute negative chips');
    const actual = Math.min(amount, this.stack);
    this.stack -= actual;
    this.betThisRound += actual;
    this.totalContributed += actual;
    if (this.stack === 0) this.allIn = true;
    return actual;
  }

  /** Receive chips (payout). */
  receive(amount) {
    if (amount < 0) throw new Error('Cannot receive negative chips');
    this.stack += amount;
  }

  isActive() {
    return !this.folded && !this.allIn;
  }

  isInHand() {
    return !this.folded;
  }
}

class SidePot {
  constructor(amount, eligibleIds) {
    this.amount = amount;
    this.eligibleIds = eligibleIds; // players who can win this pot
  }
}

/**
 * Main Game state machine + chip ledger.
 * totalChips is snapshotted at game start and must never change.
 */
class Game {
  constructor(config) {
    this.config = {
      smallBlind: config.smallBlind || 5,
      bigBlind: config.bigBlind || 10,
      ante: config.ante || 0,
      ...config
    };

    this.players = config.players.map((p, i) => new Player(i, p.name, p.stack));
    this.totalChips = this.players.reduce((sum, p) => sum + p.stack, 0);

    this.handNumber = 0;
    this.dealerIndex = 0;
    this.stage = 'setup';               // setup | preflop | flop | turn | river | showdown
    this.currentPlayerIndex = 0;
    this.currentBet = 0;                // highest betThisRound currently
    this.lastRaiseSize = 0;             // size of the last raise (for min-raise calc)
    this.lastAggressorIndex = -1;       // seat who made the last bet/raise
    this.playersActedThisRound = new Set(); // ids who have acted since last aggression
    this.pots = [];                     // SidePot[]  – rebuilt when needed
    this.actionHistory = [];            // for current hand
    this.handHistory = [];              // completed hands
    this.pendingShowdown = false;
    this.sbIndex = 0;
    this.bbIndex = 0;
  }

  /** Strict invariant check. Throws if chips have been created/destroyed. */
  assertChipInvariant(context = '') {
    const stacks = this.players.reduce((s, p) => s + p.stack, 0);
    const inPots = this.pots.reduce((s, pot) => s + pot.amount, 0);
    const total = stacks + inPots;
    if (total !== this.totalChips) {
      throw new Error(
        `CHIP INVARIANT BROKEN ${context}: stacks=${stacks} pots=${inPots} total=${total} expected=${this.totalChips}`
      );
    }
  }

  getPlayer(id) {
    return this.players.find(p => p.id === id);
  }

  /** Players still contesting the pot (not folded). Includes all-in players. */
  playersInHand() {
    return this.players.filter(p => p.isInHand());
  }

  /** Alias kept for older call sites – same as playersInHand(). */
  activePlayers() {
    return this.playersInHand();
  }

  /** Players who can still make a decision (not folded, not all-in). */
  playersStillToAct() {
    return this.players.filter(p => p.isActive());
  }

  /**
   * True when betting is finished for the hand:
   * - 0 or 1 player left in hand, or
   * - every remaining player is all-in (nobody can act).
   */
  shouldGoToShowdown() {
    const inHand = this.playersInHand();
    if (inHand.length <= 1) return true;
    return this.playersStillToAct().length === 0;
  }

  /** Rotate dealer button and assign SB / BB. */
  startNewHand() {
    this.handNumber += 1;
    this.stage = 'preflop';
    this.pots = [];
    this.actionHistory = [];
    this.currentBet = 0;
    this.lastRaiseSize = 0;
    this.pendingShowdown = false;

    this.players.forEach(p => p.resetForNewHand());

    // Move dealer
    if (this.handNumber > 1) {
      this.dealerIndex = (this.dealerIndex + 1) % this.players.length;
    }

    // Post antes if any
    if (this.config.ante > 0) {
      this.players.forEach(p => {
        const amt = p.contribute(this.config.ante);
        // antes go into the main pot later
      });
    }

    // Determine SB / BB seats (heads-up special case)
    const n = this.players.length;
    let sbIndex, bbIndex;
    if (n === 2) {
      sbIndex = this.dealerIndex;               // dealer is SB in HU
      bbIndex = (this.dealerIndex + 1) % n;
    } else {
      sbIndex = (this.dealerIndex + 1) % n;
      bbIndex = (this.dealerIndex + 2) % n;
    }

    // Post blinds
    const sbPlayer = this.players[sbIndex];
    const bbPlayer = this.players[bbIndex];
    this.sbIndex = sbIndex;
    this.bbIndex = bbIndex;

    sbPlayer.contribute(this.config.smallBlind);
    bbPlayer.contribute(this.config.bigBlind);

    this.currentBet = this.config.bigBlind;
    this.lastRaiseSize = this.config.bigBlind;
    this.lastAggressorIndex = bbIndex; // BB is the "aggressor" preflop
    this.playersActedThisRound = new Set();

    // Collect all contributed chips so far into the first pot
    this._rebuildPotsFromContributions();

    // First to act preflop is left of BB
    this.currentPlayerIndex = (bbIndex + 1) % n;

    // Skip players who are already all-in from blinds (rare but possible)
    const foundActor = this._ensureCurrentPlayerCanAct();

    // Extremely rare: every player is already all-in from blinds/antes → showdown
    if (!foundActor || this.shouldGoToShowdown()) {
      this.stage = 'showdown';
      this.pendingShowdown = true;
    }

    this.assertChipInvariant('after startNewHand');
    return {
      dealer: this.players[this.dealerIndex],
      sb: sbPlayer,
      bb: bbPlayer,
      firstToAct: this.players[this.currentPlayerIndex],
      goToShowdown: this.pendingShowdown
    };
  }

  /** Rebuild side pots from every player's totalContributed this hand. */
  _rebuildPotsFromContributions() {
    // Gather non-zero contributions
    const contribs = this.players
      .map(p => ({ id: p.id, amount: p.totalContributed, folded: p.folded }))
      .filter(c => c.amount > 0);

    if (contribs.length === 0) {
      this.pots = [];
      return;
    }

    // Unique sorted contribution levels
    const levels = [...new Set(contribs.map(c => c.amount))].sort((a, b) => a - b);

    const pots = [];
    let prevLevel = 0;

    for (const level of levels) {
      const layerSize = level - prevLevel;
      // Everyone who put in at least `level` contributes to this layer
      const contributors = contribs.filter(c => c.amount >= level);
      const potAmount = layerSize * contributors.length;

      // Eligible to win: not folded and contributed at least this level
      const eligible = contributors
        .filter(c => !c.folded)
        .map(c => c.id);

      if (potAmount > 0) {
        pots.push(new SidePot(potAmount, eligible));
      }
      prevLevel = level;
    }

    this.pots = pots;
  }

  /** Called after any contribute / fold that may create new all-ins. */
  updatePots() {
    this._rebuildPotsFromContributions();
    this.assertChipInvariant('after updatePots');
  }

  /**
   * Perform a player action.
   * Returns { success, message, amountMoved, remaining }
   */
  performAction(playerId, action, raiseToAmount = null) {
    const player = this.getPlayer(playerId);
    if (!player) return { success: false, message: 'Player not found' };
    if (player.id !== this.players[this.currentPlayerIndex].id) {
      return { success: false, message: 'Not this player\'s turn' };
    }
    if (player.folded || player.allIn) {
      return { success: false, message: 'Player cannot act' };
    }

    const toCall = Math.max(0, this.currentBet - player.betThisRound);
    let amountMoved = 0;
    let message = '';

    switch (action) {
      case 'fold':
        player.folded = true;
        message = `${player.name} folds`;
        break;

      case 'check':
        if (toCall > 0) return { success: false, message: 'Cannot check – there is a bet to call' };
        message = `${player.name} checks`;
        break;

      case 'call':
        if (toCall === 0) return { success: false, message: 'Nothing to call – use Check' };
        amountMoved = player.contribute(toCall);
        message = `${player.name} calls ${amountMoved}`;
        break;

      case 'bet': // opening bet (when currentBet === 0)
        if (this.currentBet > 0) return { success: false, message: 'There is already a bet – use Raise' };
        if (raiseToAmount == null || raiseToAmount <= 0) {
          return { success: false, message: 'Must specify bet amount' };
        }
        if (raiseToAmount > player.stack) {
          return { success: false, message: 'Not enough chips' };
        }
        // In NLHE a bet must be at least the big blind (or min raise size)
        const minBet = this.config.bigBlind;
        if (raiseToAmount < minBet && raiseToAmount < player.stack) {
          return { success: false, message: `Minimum bet is ${minBet}` };
        }
        amountMoved = player.contribute(raiseToAmount);
        this.currentBet = player.betThisRound;
        this.lastRaiseSize = raiseToAmount;
        message = `${player.name} bets ${amountMoved}`;
        break;

      case 'raise':
        if (this.currentBet === 0) return { success: false, message: 'Nothing to raise – use Bet' };
        if (raiseToAmount == null) return { success: false, message: 'Must specify raise-to amount' };

        // raiseToAmount is the total this player wants their betThisRound to become
        const minRaiseTo = this.currentBet + this.lastRaiseSize;
        if (raiseToAmount < minRaiseTo && raiseToAmount < player.stack + player.betThisRound) {
          return {
            success: false,
            message: `Minimum raise is to ${minRaiseTo}`
          };
        }

        const needed = raiseToAmount - player.betThisRound;
        if (needed <= 0) return { success: false, message: 'Raise amount must be higher than current bet' };
        if (needed > player.stack) return { success: false, message: 'Not enough chips' };

        amountMoved = player.contribute(needed);
        const raiseSize = player.betThisRound - this.currentBet;
        this.currentBet = player.betThisRound;
        this.lastRaiseSize = raiseSize;
        message = `${player.name} raises to ${this.currentBet}`;
        break;

      case 'all-in':
        const allInAmount = player.stack;
        if (allInAmount === 0) return { success: false, message: 'Already all-in' };
        amountMoved = player.contribute(allInAmount);

        if (player.betThisRound > this.currentBet) {
          // This all-in is a raise (or partial)
          const raiseSize = player.betThisRound - this.currentBet;
          // Only update lastRaiseSize if it meets the full min-raise requirement
          // (short all-in does not reopen betting in the strict sense, but we still track)
          if (raiseSize >= this.lastRaiseSize) {
            this.lastRaiseSize = raiseSize;
          }
          this.currentBet = player.betThisRound;
          message = `${player.name} goes all-in for ${amountMoved} (raises to ${this.currentBet})`;
        } else {
          message = `${player.name} goes all-in for ${amountMoved}`;
        }
        break;

      default:
        return { success: false, message: 'Unknown action' };
    }

    this.actionHistory.push({
      playerId,
      action,
      amount: amountMoved,
      message,
      stage: this.stage
    });

    // Track who has acted. Reset the acted set after any bet/raise (full aggression).
    this.playersActedThisRound.add(playerId);

    if (action === 'bet' || action === 'raise') {
      this.lastAggressorIndex = player.seatIndex;
      this.playersActedThisRound = new Set([playerId]);
    }
    // Short all-ins that do not meet min-raise do not reopen betting;
    // the unmatched-bet check in _isBettingRoundOver already handles them.

    this.updatePots();

    // Move to next player or finish round
    const roundOver = this._isBettingRoundOver();
    let nextPlayer = null;
    if (roundOver) {
      this._endBettingRound();
      // If everyone left is all-in (or only one player remains), mark showdown
      if (this.shouldGoToShowdown()) {
        this.stage = 'showdown';
        this.pendingShowdown = true;
      }
    } else {
      const found = this._advanceToNextActivePlayer();
      if (!found) {
        // Nobody left who can act → treat as end of betting + showdown
        this._endBettingRound();
        this.stage = 'showdown';
        this.pendingShowdown = true;
      } else {
        nextPlayer = this.players[this.currentPlayerIndex];
      }
    }

    this.assertChipInvariant('after action ' + action);
    return {
      success: true,
      message,
      amountMoved,
      remaining: player.stack,
      roundOver: roundOver || this.pendingShowdown,
      goToShowdown: this.pendingShowdown,
      nextPlayer: nextPlayer || this.players[this.currentPlayerIndex]
    };
  }

  _isBettingRoundOver() {
    const inHand = this.players.filter(p => p.isInHand());
    if (inHand.length <= 1) return true;

    // Anyone still able to act who has not matched the current bet?
    const unmatched = inHand.filter(p => !p.allIn && p.betThisRound < this.currentBet);
    if (unmatched.length > 0) return false;

    // Everyone has matched (or is all-in). Now check that every active player
    // has had a chance to act since the last aggression.
    const needToAct = inHand.filter(p => !p.allIn);
    if (needToAct.length === 0) return true;

    // If there was never an aggressor (everyone checked), just require all active have acted
    if (this.lastAggressorIndex < 0) {
      return needToAct.every(p => this.playersActedThisRound.has(p.id));
    }

    // After an aggression, every other non-all-in player must have acted
    return needToAct.every(p => this.playersActedThisRound.has(p.id));
  }

  _endBettingRound() {
    // Reset betThisRound for next street, keep totalContributed
    this.players.forEach(p => {
      p.betThisRound = 0;
    });
    this.currentBet = 0;
    this.lastRaiseSize = this.config.bigBlind;
    this.lastAggressorIndex = -1;
    this.playersActedThisRound = new Set();
    this.updatePots();
  }

  /**
   * Move currentPlayerIndex to the next player who can act (not folded, not all-in).
   * Always steps at least once (used after someone has just acted).
   * Returns true if a player who can act was found, false if nobody can act.
   */
  _advanceToNextActivePlayer() {
    const n = this.players.length;
    let safety = 0;
    do {
      this.currentPlayerIndex = (this.currentPlayerIndex + 1) % n;
      safety++;
      if (safety > n + 2) {
        return false;
      }
    } while (
      this.players[this.currentPlayerIndex].folded ||
      this.players[this.currentPlayerIndex].allIn
    );
    return true;
  }

  /**
   * Ensure currentPlayerIndex points at a player who can act, without
   * advancing if the current one is already valid. Used when seating the
   * first actor of a street.
   */
  _ensureCurrentPlayerCanAct() {
    const n = this.players.length;
    let safety = 0;
    while (
      this.players[this.currentPlayerIndex].folded ||
      this.players[this.currentPlayerIndex].allIn
    ) {
      this.currentPlayerIndex = (this.currentPlayerIndex + 1) % n;
      safety++;
      if (safety > n + 2) return false;
    }
    return true;
  }

  /** User advances the board (Flop / Turn / River). */
  advanceStage() {
    const order = ['preflop', 'flop', 'turn', 'river', 'showdown'];
    const idx = order.indexOf(this.stage);
    if (idx === -1 || idx >= order.length - 1) return false;

    this.stage = order[idx + 1];

    if (this.stage === 'showdown') {
      this.pendingShowdown = true;
      return true;
    }

    // If nobody can act any more (all remaining players are all-in), skip
    // further betting streets and go straight to showdown.
    if (this.shouldGoToShowdown()) {
      this.stage = 'showdown';
      this.pendingShowdown = true;
      this.assertChipInvariant('after advanceStage (all-in runout)');
      return true;
    }

    // New betting round: first to act is left of dealer
    this.currentPlayerIndex = (this.dealerIndex + 1) % this.players.length;
    this.lastAggressorIndex = -1;
    this.playersActedThisRound = new Set();
    const found = this._ensureCurrentPlayerCanAct(); // skip folded/all-in without overshooting

    // Safety: if somehow no actor was found, force showdown
    if (!found || this.shouldGoToShowdown()) {
      this.stage = 'showdown';
      this.pendingShowdown = true;
    }

    this.assertChipInvariant('after advanceStage');
    return true;
  }

  /**
   * At showdown the user selects winners for each pot.
   * winnersPerPot: array of { potIndex, winnerIds: number[] }
   * Chips are distributed equally (integer division, remainder left in pot? – we give remainder to first winner for simplicity).
   */
  distributePots(winnersPerPot) {
    if (this.stage !== 'showdown') {
      throw new Error('Can only distribute at showdown');
    }

    const results = [];

    winnersPerPot.forEach(({ potIndex, winnerIds }) => {
      const pot = this.pots[potIndex];
      if (!pot) return;

      // Validate eligibility
      const validWinners = winnerIds.filter(id => pot.eligibleIds.includes(id));
      if (validWinners.length === 0) {
        results.push({ potIndex, error: 'No valid winners selected' });
        return;
      }

      const share = Math.floor(pot.amount / validWinners.length);
      let remainder = pot.amount % validWinners.length;

      validWinners.forEach((id, i) => {
        const player = this.getPlayer(id);
        let payout = share;
        if (i === 0) payout += remainder; // simple remainder rule
        player.receive(payout);
        results.push({
          potIndex,
          playerId: id,
          name: player.name,
          amount: payout
        });
      });

      pot.amount = 0; // emptied
    });

    // Any leftover (should be zero) stays, but we clear
    this.pots = this.pots.filter(p => p.amount > 0);

    this.assertChipInvariant('after distributePots');

    // Record hand history
    this.handHistory.push({
      handNumber: this.handNumber,
      stage: this.stage,
      results,
      finalStacks: this.players.map(p => ({ id: p.id, name: p.name, stack: p.stack })),
      actions: [...this.actionHistory]
    });

    return results;
  }

  /** Snapshot for UI */
  getPublicState() {
    return {
      handNumber: this.handNumber,
      stage: this.stage,
      dealerIndex: this.dealerIndex,
      currentPlayerIndex: this.currentPlayerIndex,
      currentBet: this.currentBet,
      lastRaiseSize: this.lastRaiseSize,
      pots: this.pots.map(p => ({ amount: p.amount, eligible: p.eligibleIds })),
      totalPot: this.pots.reduce((s, p) => s + p.amount, 0),
      players: this.players.map(p => ({
        id: p.id,
        name: p.name,
        stack: p.stack,
        betThisRound: p.betThisRound,
        totalContributed: p.totalContributed,
        folded: p.folded,
        allIn: p.allIn,
        isDealer: p.seatIndex === this.dealerIndex,
        isSB: false, // computed on demand if needed
        isBB: false
      })),
      actionHistory: this.actionHistory,
      totalChips: this.totalChips
    };
  }
}

// Export for browser
if (typeof window !== 'undefined') {
  window.Player = Player;
  window.SidePot = SidePot;
  window.Game = Game;
}
