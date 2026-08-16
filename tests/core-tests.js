/**
 * Basic automated tests for Chipless Poker chip accounting & side pots.
 * Run in Node or browser console: node tests/core-tests.js  (after making models loadable)
 * Or open index.html and paste into console after loading.
 */

(function () {
  function assert(cond, msg) {
    if (!cond) throw new Error('FAIL: ' + msg);
  }

  function run() {
    console.log('Running Chipless Poker core tests...');

    // ----- Test 1: basic contribute + invariant -----
    {
      const g = new Game({
        players: [
          { name: 'A', stack: 100 },
          { name: 'B', stack: 100 }
        ],
        smallBlind: 5,
        bigBlind: 10
      });
      assert(g.totalChips === 200, 'total chips start');
      g.startNewHand();
      assert(g.players[0].stack + g.players[1].stack + g.pots.reduce((s, p) => s + p.amount, 0) === 200, 'invariant after blinds');
      console.log('  ✓ Test 1: blinds + invariant');
    }

    // ----- Test 2: call amount calculation -----
    {
      const g = new Game({
        players: [
          { name: 'A', stack: 500 },
          { name: 'B', stack: 500 },
          { name: 'C', stack: 500 }
        ],
        smallBlind: 5,
        bigBlind: 10
      });
      g.startNewHand();
      // After blinds: dealer=0, SB=1, BB=2, first to act = 0 (A)
      const a = g.players[0];
      const toCall = g.currentBet - a.betThisRound;
      assert(toCall === 10, 'A should need to call 10');
      const res = g.performAction(a.id, 'call');
      assert(res.success, 'call should succeed');
      assert(a.stack === 490, 'A stack after call');
      console.log('  ✓ Test 2: call calculation');
    }

    // ----- Test 3: all-in creates side pot -----
    {
      const g = new Game({
        players: [
          { name: 'Short', stack: 30 },
          { name: 'Mid', stack: 80 },
          { name: 'Deep', stack: 200 }
        ],
        smallBlind: 5,
        bigBlind: 10
      });
      // Force positions for determinism: dealer = 0 (Short)
      g.dealerIndex = 0;
      g.startNewHand();
      // SB = Mid (1) posts 5, BB = Deep (2) posts 10
      // First to act = Short (0)

      // Short goes all-in for 30
      let r = g.performAction(0, 'all-in');
      assert(r.success, 'short all-in');

      // Mid calls (needs to put more to match)
      // After short all-in currentBet should be 30
      r = g.performAction(1, 'call');
      assert(r.success, 'mid call');

      // Deep calls
      r = g.performAction(2, 'call');
      assert(r.success, 'deep call');

      // Now pots should have main (everyone) and side (mid+deep)
      g.updatePots();
      const totalPot = g.pots.reduce((s, p) => s + p.amount, 0);
      // Short 30 + Mid 30 + Deep 30 = 90 main-ish, then Mid+Deep extra if any
      // Actually after calls everyone has put 30 → one pot of 90
      assert(totalPot === 90, 'total pot after equal all-in call = 90, got ' + totalPot);
      console.log('  ✓ Test 3: all-in equal contribution');
    }

    // ----- Test 4: side pot with different all-in amounts -----
    {
      const g = new Game({
        players: [
          { name: 'S', stack: 25 },
          { name: 'M', stack: 60 },
          { name: 'D', stack: 150 }
        ],
        smallBlind: 5,
        bigBlind: 10
      });
      g.dealerIndex = 2; // so SB=S(0), BB=M(1), first=D(2) wait, recalculate
      // Better: just start and force actions carefully
      g.startNewHand();
      // We don't care exact seats; just force contributions via direct contribute for pure pot test
    }

    // Direct side-pot unit test (bypassing full betting)
    {
      const g = new Game({
        players: [
          { name: 'S', stack: 100 },
          { name: 'M', stack: 100 },
          { name: 'D', stack: 100 }
        ],
        smallBlind: 1,
        bigBlind: 2
      });
      // Manually set contributions
      g.players[0].totalContributed = 25;
      g.players[0].stack = 75;
      g.players[1].totalContributed = 60;
      g.players[1].stack = 40;
      g.players[2].totalContributed = 60;
      g.players[2].stack = 40;
      g.players[0].folded = false;
      g.players[1].folded = false;
      g.players[2].folded = false;

      g._rebuildPotsFromContributions();

      // Expected:
      // Level 25: 25 * 3 = 75  → eligible all three
      // Level 60: 35 * 2 = 70  → eligible M and D
      assert(g.pots.length === 2, 'should have 2 pots');
      assert(g.pots[0].amount === 75, 'main pot 75');
      assert(g.pots[0].eligibleIds.length === 3, 'main eligible 3');
      assert(g.pots[1].amount === 70, 'side pot 70');
      assert(g.pots[1].eligibleIds.length === 2, 'side eligible 2');
      assert(g.players.reduce((s, p) => s + p.stack, 0) + 75 + 70 === 300, 'invariant');
      console.log('  ✓ Test 4: side pot calculation');
    }

    // ----- Test 5: fold removes eligibility -----
    {
      const g = new Game({
        players: [
          { name: 'A', stack: 100 },
          { name: 'B', stack: 100 },
          { name: 'C', stack: 100 }
        ],
        smallBlind: 1,
        bigBlind: 2
      });
      g.players[0].totalContributed = 50;
      g.players[1].totalContributed = 50;
      g.players[2].totalContributed = 50;
      g.players[0].folded = true;
      g.players[1].folded = false;
      g.players[2].folded = false;
      g._rebuildPotsFromContributions();
      assert(g.pots[0].eligibleIds.length === 2, 'folded player not eligible');
      assert(!g.pots[0].eligibleIds.includes(0), 'A not in eligible');
      console.log('  ✓ Test 5: fold removes eligibility');
    }

    // ----- Test 6: split pot payout -----
    {
      const g = new Game({
        players: [
          { name: 'A', stack: 0 },
          { name: 'B', stack: 0 },
          { name: 'C', stack: 0 }
        ],
        smallBlind: 1,
        bigBlind: 2
      });
      g.totalChips = 300;
      g.players[0].totalContributed = 100;
      g.players[1].totalContributed = 100;
      g.players[2].totalContributed = 100;
      g.stage = 'showdown';
      g._rebuildPotsFromContributions();
      assert(g.pots[0].amount === 300, 'one pot 300');

      const results = g.distributePots([
        { potIndex: 0, winnerIds: [0, 1] } // A and B split
      ]);
      assert(g.players[0].stack === 150, 'A gets 150');
      assert(g.players[1].stack === 150, 'B gets 150');
      assert(g.players[2].stack === 0, 'C gets 0');
      assert(g.players.reduce((s, p) => s + p.stack, 0) === 300, 'invariant after split');
      console.log('  ✓ Test 6: split pot payout');
    }

    console.log('\nAll core tests passed.');
  }

  // Export or auto-run
  if (typeof window !== 'undefined') {
    window.runChiplessTests = run;
    console.log('Tests loaded. Call runChiplessTests() in console.');
  } else if (typeof module !== 'undefined') {
    // Node – would need to load models first
    module.exports = { run };
  } else {
    run();
  }
})();
