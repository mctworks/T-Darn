/*:
 * @plugindesc v1.0.0 "T-Darn" Combat System
 * @author ReverendCrush, Michael "MCT630" Thompson
 * 
 * @help
 * ============================================================================
 * Introduction
 * ============================================================================
 * This plugin replaces the default battle system with a d20-based TTRPG
 * style combat system based on the "Tinker's Damn" combat system. The "T-Darn" 
 * system features initiative rolls, hit locations, and armor zones.
 */

var Imported = Imported || {};
Imported.TDarnCombatSystem = true;

(function() {
    'use strict';

//=============================================================================
// BATTLE SYSTEM VERIFICATION
//=============================================================================
console.log('Checking battle system...');
console.log('Game_Action.prototype.apply exists:', !!Game_Action.prototype.apply);
console.log('BattleManager exists:', !!BattleManager);
console.log('Scene_Battle exists:', !!Scene_Battle);

// Store original methods
const _Scene_Battle_start = Scene_Battle.prototype.start;
const _Scene_Battle_createAllWindows = Scene_Battle.prototype.createAllWindows;
const _BattleManager_startTurn = BattleManager.startTurn;
const _BattleManager_makeActionOrders = BattleManager.makeActionOrders;
const _BattleManager_getNextSubject = BattleManager.getNextSubject;
const _Window_ActorCommand_makeCommandList = Window_ActorCommand.prototype.makeCommandList;
const _Scene_Battle_createActorCommandWindow = Scene_Battle.prototype.createActorCommandWindow;

//=============================================================================
// Global Error Handler for Debugging
//=============================================================================
window.addEventListener('error', function(e) {
    console.error('GLOBAL ERROR:', e.error);
    alert('Error: ' + e.message + '\n\nSee console for details (F8)');
});

console.log('=== TDARN PLUGIN STARTING ===');
    
//=============================================================================
// Hit Location System with Creature Type Support
//=============================================================================

const CREATURE_TYPES = {
    HUMANOID: 'humanoid',
    WINGED: 'winged',
    LIMBLESS: 'limbless',
    QUADRUPED: 'quadruped',
    SERPENT: 'serpent',
    INSECTOID: 'insectoid'
};

const HIT_LOCATIONS = {
    HUMANOID: {
        1: { name: 'Head', multiplier: 2, range: [1,2], armorType: 'head' },
        2: { name: 'Torso', multiplier: 1, range: [3,10], armorType: 'torso' },
        3: { name: 'Arms', multiplier: 0.5, range: [11,15], armorType: 'arms' },
        4: { name: 'Legs', multiplier: 0.5, range: [16,20], armorType: 'legs' }
    },
    WINGED: {
        1: { name: 'Head', multiplier: 2, range: [1,2], armorType: 'head' },
        2: { name: 'Body', multiplier: 1, range: [3,10], armorType: 'torso' },
        3: { name: 'Wings', multiplier: 0.5, range: [11,15], armorType: 'arms' },
        4: { name: 'Legs', multiplier: 0.5, range: [16,20], armorType: 'legs' }
    },
    LIMBLESS: {
        1: { name: 'Core', multiplier: 2, range: [1,3], armorType: 'head' },
        2: { name: 'Body', multiplier: 1, range: [4,20], armorType: 'torso' }
    },
    QUADRUPED: {
        1: { name: 'Head', multiplier: 2, range: [1,2], armorType: 'head' },
        2: { name: 'Body', multiplier: 1, range: [3,12], armorType: 'torso' },
        3: { name: 'Legs', multiplier: 0.5, range: [13,20], armorType: 'legs' }
    },
    SERPENT: {
        1: { name: 'Head', multiplier: 2, range: [1,3], armorType: 'head' },
        2: { name: 'Body', multiplier: 1, range: [4,15], armorType: 'torso' },
        3: { name: 'Tail', multiplier: 0.5, range: [16,20], armorType: 'legs' }
    },
    INSECTOID: {
        1: { name: 'Head', multiplier: 2, range: [1,2], armorType: 'head' },
        2: { name: 'Thorax', multiplier: 1, range: [3,8], armorType: 'torso' },
        3: { name: 'Abdomen', multiplier: 1, range: [9,14], armorType: 'torso' },
        4: { name: 'Legs/Wings', multiplier: 0.5, range: [15,20], armorType: 'arms' }
    }
};

const DEFAULT_TYPE = CREATURE_TYPES.HUMANOID;

function getCreatureType(battler) {
    if (battler.isEnemy()) {
        const enemy = battler.enemy();
        if (enemy && enemy.meta && enemy.meta.creatureType) {
            return enemy.meta.creatureType;
        }
    }
    return DEFAULT_TYPE;
}

function determineHitLocation(battler) {
    const creatureType = getCreatureType(battler);
    const locationTable = HIT_LOCATIONS[creatureType.toUpperCase()] || HIT_LOCATIONS.HUMANOID;
    
    const roll = Math.floor(Math.random() * 20) + 1;
    for (let key in locationTable) {
        const loc = locationTable[key];
        if (roll >= loc.range[0] && roll <= loc.range[1]) {
            return loc;
        }
    }
    return locationTable[1];
}

//=============================================================================
// Note Tag Parsing
//=============================================================================

const getWeaponSkill = function(weapon) {
    if (!weapon) return 0;
    const meta = weapon.meta;
    return parseInt(meta.weaponSkill) || 0;
};

const getDamageDice = function(weapon) {
    if (!weapon) return 1;
    const meta = weapon.meta;
    return parseInt(meta.damageDice) || 1;
};

const getWeaponDamage = function(weapon) {
    if (!weapon) return { dice: 1, sides: 4 }; // Unarmed: 1d4
    
    const meta = weapon.meta;
    
    // Format: <damage: 2d6> or <damage: 1d8>
    if (meta && meta.damage) {
        const match = meta.damage.match(/(\d+)d(\d+)/i);
        if (match) {
            return {
                dice: parseInt(match[1]),
                sides: parseInt(match[2])
            };
        }
    }
    
    // Fallback to old tags for compatibility
    const dice = parseInt(meta && meta.damageDice) || 1;
    return { dice: dice, sides: 6 };
};

const getArmorAtLocation = function(armors, location) {
    for (let i = 0; i < armors.length; i++) {
        const armor = armors[i];
        if (armor && armor.meta && armor.meta.armorLocation === location) {
            const value = parseInt(armor.meta.armorStrength);
            return isNaN(value) ? 0 : value;
        }
    }
    return 0;
};

const getWeaponRange = function(weapon) {
    if (!weapon) return 'melee';
    return (weapon.meta && weapon.meta.range) || 'melee';
};

//=============================================================================
// Game_Action Overrides
//=============================================================================

Game_Action.prototype.isMeleeAttack = function() {
    const subject = this.subject();
    if (!subject) return true;
    const weapon = subject.weapons ? subject.weapons()[0] : null;
    return !weapon || getWeaponRange(weapon) === 'melee';
};

const _Game_Action_apply = Game_Action.prototype.apply;
Game_Action.prototype.apply = function(target) {
    const subject = this.subject();
    if (!subject) return;
    // Guard self-target = move no-op. Skip all combat logic.
    if (subject === target && this.isGuard && this.isGuard()) {
        target.result().clear();
        return;
    }
    
    const weapon = subject.weapons ? subject.weapons()[0] : null;
    
    const attackRoll = Math.floor(Math.random() * 20) + 1 + subject.agi + getWeaponSkill(weapon);
    const defenseRoll = Math.floor(Math.random() * 20) + 1 + target.agi;
    const isNatural20 = (attackRoll - subject.agi - getWeaponSkill(weapon)) === 20;
    
    const distance = getRangeDistance(subject, target);
    const rangeMod = getRangeModifier(distance);
    const finalAttackRoll = attackRoll + rangeMod;

    console.log(subject.name() + ' attacking ' + target.name() + 
                ' | Distance: ' + distance + 
                ' | Range Mod: ' + rangeMod + 
                ' | Attack Roll: ' + attackRoll + 
                ' | Final: ' + finalAttackRoll + 
                ' | Defense: ' + defenseRoll);
    
    if (finalAttackRoll > defenseRoll || isNatural20) {
        this.applyHitWithLocation(target, isNatural20);
    } else {
        this.checkParry(target);
    }
};

Game_Action.prototype.checkParry = function(target) {
    const defenderMeleeSkill = target.skillLevel ? target.skillLevel('Melee') : 0;
    const parryRoll = Math.floor(Math.random() * 20) + 1 + target.agi + defenderMeleeSkill;
    const blockDC = 10 + Math.floor(defenderMeleeSkill / 2);
    
    if (parryRoll >= blockDC) {
        target.result().missed = false;
        target.result().evaded = false;  // evaded=true shows "Miss"; keep false so damage number shows
        
        if (this.isMeleeAttack()) {
            target._parryPenalty = -1;
        }
        
        const subject = this.subject();
        if (!subject) return;
        
        const weapon = subject.weapons ? subject.weapons()[0] : null;
        const damageDice = getDamageDice(weapon);
        
        let damage = 0;
        for (let i = 0; i < damageDice; i++) {
            damage += Math.floor(Math.random() * 6) + 1;
        }
        
        if (this.isMeleeAttack()) {
            damage += Math.floor(subject.atk / 4);
        }
        
        if (isNaN(damage) || !isFinite(damage)) damage = 0;
        
        const finalDamage = Math.floor(damage / 2);
        
        if (isNaN(finalDamage) || !isFinite(finalDamage) || finalDamage < 0) {
            target.result().missed = true;
            target.result().clear();
            return;
        }
        
        target.result().hpDamage = finalDamage;
        target.result().hpAffected = true;
        target.gainHp(-finalDamage);
        target.startDamagePopup();
        
        console.log('PARRY: ' + target.name() + ' takes half damage (' + finalDamage + ')');
    } else {
        target.result().missed = true;
        target.result().clear();
    }
};

Game_Action.prototype.applyHitWithLocation = function(target, isNatural20) {
    const hitLocation = determineHitLocation(target);
    
    const subject = this.subject();
    if (!subject) return;
    
    const weapon = subject.weapons ? subject.weapons()[0] : null;
    const weaponDamage = getWeaponDamage(weapon);
    
    let damage = 0;
    for (let i = 0; i < weaponDamage.dice; i++) {
        damage += Math.floor(Math.random() * weaponDamage.sides) + 1;
    }
    
    damage += weapon ? weapon.params[2] : 0;
    
    if (this.isMeleeAttack()) {
        damage += Math.floor(subject.atk / 4);
    }
    
    if (isNaN(damage) || !isFinite(damage)) damage = 1;
    if (damage < 1) damage = 1;
    
    const armors = target.armors ? target.armors() : [];
    const armorStrength = getArmorAtLocation(armors, hitLocation.armorType);
    
    if (isNaN(armorStrength) || !isFinite(armorStrength)) armorStrength = 0;
    
    let finalDamage = Math.max(0, damage - Math.floor(armorStrength / 2));
    
    if (isNatural20) {
        finalDamage *= 2;
    }
    
    finalDamage = Math.floor(finalDamage * hitLocation.multiplier);
    
    if (isNaN(finalDamage) || !isFinite(finalDamage)) finalDamage = 1;
    if (finalDamage < 1) finalDamage = 1;
    
    target.result().clear();
    target.result().hpDamage = finalDamage;
    target.result().hpAffected = true;
    target.gainHp(-finalDamage);
    target.result().hitLocation = hitLocation.name;
    
    if (isNatural20) {
        target.result().critical = true;
    }
    
    target.startDamagePopup();
    
    console.log('HIT: ' + subject.name() + ' -> ' + target.name() + 
                ' | Location: ' + hitLocation.name + 
                ' | Damage: ' + finalDamage +
                (isNatural20 ? ' | CRITICAL!' : ''));
};

const _Game_Battler_makeSpeed = Game_Battler.prototype.makeSpeed;
Game_Battler.prototype.makeSpeed = function() {
    _Game_Battler_makeSpeed.call(this);
    if (this._parryPenalty) {
        this._speed += this._parryPenalty;
        delete this._parryPenalty;
    }
};

//=============================================================================
// BattleManager Initiative Override
//=============================================================================

// Module-level guard so re-entrancy protection works regardless of `this` context.
// YEP_X_TurnOrderDisplay hooks Game_Action.clear() → calls makeActionOrders every
// time a new Game_Action is created. makeActions() creates Game_Actions, so without
// this guard we get: makeActions → new Game_Action → clear → makeActionOrders →
// makeActions → ... infinite loop. The guard makes re-entrant calls no-ops.
// makeActions() is intentionally NOT called here — it lives in startInput so that
// Yanfly's legitimate calls to makeActionOrders (for display refresh) don't
// re-allocate action slots and wipe actors' chosen actions mid-turn.
var _TDarn_makingActionOrders = false;

BattleManager.makeActionOrders = function() {
    if (_TDarn_makingActionOrders) return;
    _TDarn_makingActionOrders = true;

    var combatants = [];
    $gameParty.aliveMembers().forEach(function(m) { combatants.push(m); });
    $gameTroop.aliveMembers().forEach(function(m) { combatants.push(m); });

    if (combatants.length > 0) {
        combatants.forEach(function(battler) {
            // Only re-roll initiative if not already set this turn
            if (battler._initiative === undefined || battler._initiative === null) {
                battler._initiative = Math.floor(Math.random() * 20) + 1 + battler.agi;
            }
            battler.makeSpeed();
        });
        this._actionBattlers = combatants.sort(function(a, b) {
            return b._initiative - a._initiative;
        });
    } else {
        this._actionBattlers = [];
    }

    _TDarn_makingActionOrders = false;
};

//=============================================================================
// Four-Column Range System
//=============================================================================

Game_Actor.prototype.setBattlePosition = function(column) {
    this._battleColumn = Math.max(0, Math.min(3, column));
    
    if (SceneManager._scene && SceneManager._scene._spriteset) {
        SceneManager._scene._spriteset.updateActorPositions();
    }
};

Game_Actor.prototype.battlePosition = function() {
    return this._battleColumn !== undefined ? this._battleColumn : 1;
};

Game_Enemy.prototype.battlePosition = function() {
    const enemy = this.enemy();
    if (enemy && enemy.meta && enemy.meta.column) {
        return parseInt(enemy.meta.column) || 1;
    }
    return 1;
};

function getRangeDistance(attacker, target) {
    const attackerPos = attacker.battlePosition ? attacker.battlePosition() : 1;
    const targetPos = target.battlePosition ? target.battlePosition() : 1;
    
    if (attacker.isActor() === target.isActor()) return 0;
    
    const distance = Math.abs(attackerPos - targetPos);
    return distance;
}

function getRangeModifier(distance) {
    switch(distance) {
        case 0: return 4;
        case 1: return 2;
        case 2: return 0;
        case 3: return -2;
        case 4: return -4;
        default: return -4;
    }
}

//=============================================================================
// Visual Positioning for Columns
//=============================================================================

const _Spriteset_Battle_createActors = Spriteset_Battle.prototype.createActors;
Spriteset_Battle.prototype.createActors = function() {
    _Spriteset_Battle_createActors.call(this);
    this.updateActorPositions();
};

Spriteset_Battle.prototype.updateActorPositions = function() {
    console.log('updateActorPositions CALLED');
    if (!this._actorSprites) return;
    
    const members = $gameParty.battleMembers();
    const baseX = 700;
    const baseY = Graphics.height - 200;
    const spacing = 100;
    const backRowOffset = 60;
    const backRowYOffset = 30;
    
    for (let i = 0; i < this._actorSprites.length; i++) {
        const sprite = this._actorSprites[i];
        const actor = members[i];
        if (sprite && actor) {
            const column = actor.battlePosition ? actor.battlePosition() : 1;
            
            let x = baseX - (i * spacing);
            let y = baseY;
            
            // All columns use same scale/opacity — position only
            sprite.opacity = 255;
            sprite.scale.x = 1.0;
            sprite.scale.y = 1.0;
            
            sprite.x = x;
            sprite.y = y;
        }
    }
};

//=============================================================================
// Formation Commands
//=============================================================================

Game_Actor.prototype.moveForward = function() {
    const currentPos = this.battlePosition();
    if (currentPos < 3) {
        this.setBattlePosition(currentPos + 1);
        return true;
    }
    return false;
};

Game_Actor.prototype.moveBackward = function() {
    const currentPos = this.battlePosition();
    if (currentPos > 0) {
        this.setBattlePosition(currentPos - 1);
        return true;
    }
    return false;
};

//=============================================================================
// Move Command Window
//=============================================================================

function Window_MoveCommand() {
    this.initialize.apply(this, arguments);
}

Window_MoveCommand.prototype = Object.create(Window_Command.prototype);
Window_MoveCommand.prototype.constructor = Window_MoveCommand;

Window_MoveCommand.prototype.initialize = function(x, y) {
    Window_Command.prototype.initialize.call(this, x, y);
    this._actor = null;
    this._moveChoice = null;
    // Window_Command.initialize leaves window active with index 0 selected.
    // Deactivate so it doesn't steal the first keypress on battle start.
    this.deactivate();
    this.select(-1);
};

Window_MoveCommand.prototype.windowWidth = function() {
    return 200;
};

Window_MoveCommand.prototype.makeCommandList = function() {
    this.addCommand('Forward', 'forward');
    this.addCommand('Back', 'back');
    this.addCommand('Cancel', 'cancel');
};

Window_MoveCommand.prototype.setActor = function(actor) {
    this._actor = actor;
    this._moveChoice = null;
};

Window_MoveCommand.prototype.processOk = function() {
    const currentSymbol = this.currentSymbol();
    console.log('Window_MoveCommand.processOk, symbol:', currentSymbol);
    this.deactivate();
    SoundManager.playOk();
    if (this.isHandled(currentSymbol)) {
        this.callHandler(currentSymbol);
    } else {
        this.activate();
    }
};

//=============================================================================
// Move Command System
//=============================================================================

// Add Move command to actor commands (guard against duplicates on refresh)
Window_ActorCommand.prototype.makeCommandList = function() {
    _Window_ActorCommand_makeCommandList.call(this);
    if (!this._list.some(cmd => cmd.symbol === 'move')) {
        this.addCommand('Move', 'move', true);
    }
};

// Scene_Battle additions
Scene_Battle.prototype.createAllWindows = function() {
    _Scene_Battle_createAllWindows.call(this);
    
    this._moveWindow = new Window_MoveCommand(0, 0);
    this._moveWindow.setHandler('forward', this.onMoveForward.bind(this));
    this._moveWindow.setHandler('back', this.onMoveBack.bind(this));
    this._moveWindow.setHandler('cancel', this.onMoveCancel.bind(this));
    
    this._moveWindow.x = Graphics.boxWidth - this._moveWindow.width;
    this._moveWindow.y = this._statusWindow.y - this._moveWindow.height;
    
    this.addWindow(this._moveWindow);
    this._moveWindow.hide();
    console.log('Move window created');
};

Scene_Battle.prototype.isAnyInputWindowActive = function() {
    return (this._partyCommandWindow.active ||
            this._actorCommandWindow.active ||
            this._skillWindow.active ||
            this._itemWindow.active ||
            this._actorWindow.active ||
            this._enemyWindow.active ||
            (this._moveWindow && this._moveWindow.active));
};

// Handle Move selection
Scene_Battle.prototype.createActorCommandWindow = function() {
    _Scene_Battle_createActorCommandWindow.call(this);
    this._actorCommandWindow.setHandler('move', this.onMove.bind(this));
    console.log('Move handler set');
};

// Ensure the actor command window is always visible when an actor needs to input.
// onMove() calls hide() on it, and Window_ActorCommand.setup() only calls open()
// (which controls the slide animation), NOT show() (which controls visibility).
// So after a Move command, the window is invisible for all subsequent actors.
Scene_Battle.prototype.startActorCommandSelection = function() {
    this._actorCommandWindow.show();
    this._actorCommandWindow.setup(BattleManager.actor());
};

// Move command handlers
Scene_Battle.prototype.onMove = function() {
    console.log('=== MOVE COMMAND SELECTED ===');
    const actor = BattleManager.actor();
    console.log('Actor:', actor.name());
    console.log('Current position:', actor.battlePosition());
    
    this._moveActor = actor;
    this._moveActor._moveAction = true;
    
    this._actorCommandWindow.deactivate();
    this._actorCommandWindow.hide();
    
    this._moveWindow.setActor(this._moveActor);
    this._moveWindow.show();
    this._moveWindow.activate();
    this._moveWindow.select(0);
    
    console.log('Move window shown and active');
};

Scene_Battle.prototype.onMoveForward = function() {
    console.log('=== MOVE FORWARD SELECTED ===');
    const actor = this._moveActor;
    if (!actor) {
        this.cancelMove();
        return;
    }
    
    actor._moveDirection = 'forward';
    actor._moveModifier = 1;
    console.log(actor.name(), 'will move forward with +1 modifier');
    BattleManager._targetIndex = -1; // Clear any target selection
    
    this.completeMove(actor);
};

Scene_Battle.prototype.onMoveBack = function() {
    console.log('=== MOVE BACK SELECTED ===');
    const actor = this._moveActor;
    if (!actor) {
        this.cancelMove();
        return;
    }
    
    actor._moveDirection = 'back';
    actor._moveModifier = -1;
    console.log(actor.name(), 'will move back with -1 modifier');
    BattleManager._targetIndex = -1; // Clear any target selection
    
    this.completeMove(actor);
};

Scene_Battle.prototype.onMoveCancel = function() {
    console.log('=== MOVE CANCELED ===');
    this.cancelMove();
};

Scene_Battle.prototype.cancelMove = function() {
    console.log('=== CANCEL MOVE ===');
    
    this._moveWindow.hide();
    this._moveWindow.deactivate();
    
    if (this._moveActor) {
        this._moveActor._moveAction = false;
        this._moveActor._moveDirection = null;
        this._moveActor._moveModifier = 0;
        this._moveActor = null;
    }
    
    this._actorCommandWindow.show();
    this._actorCommandWindow.activate();
};

// ─────────────────────────────────────────────────────────────────────────────
// Move Animation System
//
// Timeline:
//   Menu selection  → actor starts walk cycle (motion only, no position change)
//   All menus done  → combat execution phase begins normally
//   Actor's turn    → sprite slides to new column position over ~20 frames
//                     walk cycle continues during slide, then returns to normal
//
// Actors with a pending move store their direction in actor._pendingMoveDir.
// ─────────────────────────────────────────────────────────────────────────────

// Helper: find the Sprite_Actor for a given Game_Actor
Scene_Battle.prototype.getActorSprite = function(actor) {
    var ss = this._spriteset;
    if (!ss || !ss._actorSprites) return null;
    var members = $gameParty.battleMembers();
    var idx = members.indexOf(actor);
    return (idx >= 0) ? ss._actorSprites[idx] : null;
};

Scene_Battle.prototype.completeMove = function(actor) {
    console.log('=== COMPLETE MOVE ===');

    this._moveWindow.deactivate();
    this._moveWindow.hide();
    this._moveWindow.select(-1);
    this._moveActor = null;

    if (actor) {
        var dir = actor._moveDirection;

        // Apply logical position change immediately for correct range calculations
        if (dir === 'forward') {
            actor.moveForward();
            console.log(actor.name(), 'logical position ->', actor.battlePosition());
        } else if (dir === 'back') {
            actor.moveBackward();
            console.log(actor.name(), 'logical position ->', actor.battlePosition());
        }

        // Store direction for the execution-phase animation
        actor._pendingMoveDir = dir;
        actor._moveDirection = null;
        actor._moveModifier = 0;
        actor._moveAction = false;

        // Start walk cycle now (pure visual, no position change yet)
        var sprite = this.getActorSprite(actor);
        if (sprite && sprite.startMotion) {
            sprite.startMotion('walk', true);
        }

        // Set Guard as the action for this actor's execution-phase slot
        if (actor.inputtingAction && actor.inputtingAction()) {
            actor.inputtingAction().setGuard();
        }
    }

    // Advance to next actor's command window immediately — no delay
    BattleManager.selectNextCommand();
};

// Intercept processTurn to play the move animation BEFORE the action executes.
// We must intercept here (not in startAction) because processTurn calls
// removeCurrentAction() immediately after startAction returns — if we delayed
// inside startAction, the action would be gone by the time the timer fires.
const _BattleManager_processTurn = BattleManager.processTurn;
BattleManager.processTurn = function() {
    var subject = this._subject;
    if (subject && subject.isActor() && subject._pendingMoveDir) {
        var scene = SceneManager._scene;
        if (scene && scene.playMoveAnimation) {
            this._phase = 'animate'; // pause battle loop
            scene.playMoveAnimation(subject);
            return;
        }
    }
    _BattleManager_processTurn.call(this);
};

// Slide the actor sprite to their new column position.
// When done, restores phase and re-runs processTurn so the action executes normally.
Scene_Battle.prototype.playMoveAnimation = function(actor) {
    var sprite = this.getActorSprite(actor);
    var dir = actor._pendingMoveDir;
    actor._pendingMoveDir = null;

    var SLIDE_PX = 100;
    var DURATION = 20;
    var offsetX = (dir === 'forward') ? -SLIDE_PX : SLIDE_PX;
    var spriteset = this._spriteset;

    var finish = function() {
        if (spriteset) spriteset.updateActorPositions();
        if (sprite && sprite.setDirection) sprite.setDirection(4);
        if (sprite && sprite.startMotion) sprite.startMotion('wait', true);
        BattleManager._phase = 'turn';
        _BattleManager_processTurn.call(BattleManager);
    };

    if (!sprite) {
        finish();
        return;
    }

    // Walk cycle facing left (toward enemies) regardless of move direction
    if (sprite.setDirection) sprite.setDirection(4);
    if (sprite.startMotion) sprite.startMotion('walk', true);

    // startMove() offsets from _homeX and snaps back when done — not permanent.
    // Lerp x manually each frame and update _homeX so the sprite stays put.
    var startX = sprite.x;
    var destX = sprite.x + offsetX;
    sprite._homeX = destX;

    this._moveAnimTimer = 0;
    this._moveAnimDuration = DURATION;
    this._moveAnimStartX = startX;
    this._moveAnimDestX = destX;
    this._moveAnimSprite = sprite;
    this._moveAnimFinish = finish;
};

// Tick the move animation timer every frame.
const _Scene_Battle_update = Scene_Battle.prototype.update;
Scene_Battle.prototype.update = function() {
    _Scene_Battle_update.call(this);
    if (this._moveAnimTimer !== null && this._moveAnimTimer !== undefined) {
        this._moveAnimTimer++;
        // Lerp the sprite x toward destination each frame
        var sp = this._moveAnimSprite;
        if (sp && this._moveAnimDuration > 0) {
            var t = Math.min(this._moveAnimTimer / this._moveAnimDuration, 1);
            sp.x = this._moveAnimStartX + (this._moveAnimDestX - this._moveAnimStartX) * t;
        }
        if (this._moveAnimTimer >= this._moveAnimDuration) {
            if (sp) sp.x = this._moveAnimDestX; // snap exact
            var fn = this._moveAnimFinish;
            this._moveAnimTimer = null;
            this._moveAnimDuration = null;
            this._moveAnimStartX = null;
            this._moveAnimDestX = null;
            this._moveAnimSprite = null;
            this._moveAnimFinish = null;
            if (fn) fn();
        }
    }
};

console.log('Move command system loaded');

//=============================================================================
// Hook overrides
//=============================================================================

Scene_Battle.prototype.start = function() {
    console.log('=== BATTLE STARTED ===');
    console.log('Party members:', $gameParty.members().map(m => m.name()));
    console.log('Troop members:', $gameTroop.members().map(m => m.name()));
    // Do NOT call makeActionOrders here — startBattle→startInput does it.
    _Scene_Battle_start.call(this);
};

// startInput: runs at battle start AND after each turn ends (via endTurn).
// This is where actors choose their actions. We override to control timing of
// makeActionOrders and to reset actorIndex correctly.
BattleManager.startInput = function() {
    console.log('=== START INPUT ===');
    this._phase = 'input';
    this._actorIndex = -1;

    // Allocate action slots FIRST (creates Game_Action objects).
    // This triggers Yanfly's makeActionOrders hook, but the guard makes
    // those calls no-ops. We then do the real initiative roll below.
    $gameParty.makeActions();
    $gameTroop.makeActions();

    // Clear stale initiative so makeActionOrders rolls fresh this turn.
    var everyone = $gameParty.aliveMembers().concat($gameTroop.aliveMembers());
    everyone.forEach(function(b) { b._initiative = null; });

    // Roll initiative and sort into _actionBattlers.
    this.makeActionOrders();

    // Log the final order.
    if (this._actionBattlers) {
        console.log('Initiative order:', this._actionBattlers.map(function(b) {
            return b.name() + '(' + b._initiative + ')';
        }).join(', '));
    }

    // makeActions() sets _actionState='undecided' but selectNextCommand requires
    // 'inputting'. Set all actors to 'inputting' so each gets a command window.
    $gameParty.battleMembers().forEach(function(actor) {
        if (actor.canMove()) actor.setActionState('inputting');
    });

    // DO NOT call selectNextCommand() here. Vanilla startInput doesn't either.
    // Scene_Battle's update loop calls it when the scene is ready.
    // Calling it ourselves fires it before Yanfly's windows are initialized,
    // so canInput() is false for all actors, causing immediate startTurn() and
    // nobody ever gets a command window.
    this.clearActor();
    // If surprise attack or no one can input, skip straight to execution.
    if (this._surprise || !$gameParty.canInput()) {
        this.startTurn();
    }
};

// startTurn: called by selectNextCommand when all actors have finished inputting.
// Sets up the execution phase using the _actionBattlers order from makeActionOrders.
// Do NOT call vanilla _BattleManager_startTurn — it calls makeActionOrders() again
// which would overwrite our initiative-sorted order.
BattleManager.startTurn = function() {
    console.log('=== START TURN: execution phase ===');
    console.log('Turn order:', this._actionBattlers.map(function(b) { return b.name(); }));
    this._phase = 'turn';
    // Clear the log window exactly as vanilla does — Yanfly requires this.
    if (this._logWindow) this._logWindow.clear();
    // Vanilla startTurn assigns the first subject immediately. Without this,
    // updateTurn sees _subject=null, calls getNextSubject() which shift()s
    // everything off _actionBattlers in one loop, returns null, then endTurn
    // fires → startInput → infinite loop with nobody ever acting.
    this._subject = this.getNextSubject();
};



// Override getNextSubject completely with vanilla logic.
// Yanfly's version (captured in _BattleManager_getNextSubject) returns null
// without consuming _actionBattlers — its check is incompatible with our
// initiative-based _actionBattlers array. Vanilla logic is exactly what we need:
// shift battlers off until we find one that is alive and a battle member.
BattleManager.getNextSubject = function() {
    for (;;) {
        var battler = this._actionBattlers.shift();
        if (!battler) return null;
        if (battler.isBattleMember() && battler.isAlive()) return battler;
    }
};

//=============================================================================
// Plugin Commands
//=============================================================================

const _Game_Interpreter_pluginCommand = Game_Interpreter.prototype.pluginCommand;
Game_Interpreter.prototype.pluginCommand = function(command, args) {
    _Game_Interpreter_pluginCommand.call(this, command, args);
    
    if (command === 'TDarn_ShowInitiative') {
        if ($gameParty.inBattle()) {
            const combatants = $gameParty.members().concat($gameTroop.members());
            let msg = 'Initiative Order:\n';
            combatants.sort((a, b) => b._initiative - a._initiative)
                .forEach(b => {
                    msg += b.name() + ': ' + b._initiative + '\n';
                });
            $gameMessage.add(msg);
        }
    }
    
    if (command === 'TDarn_RollHitLocation') {
        const testBattler = $gameTroop.members()[0] || $gameParty.members()[0];
        if (testBattler) {
            const loc = determineHitLocation(testBattler);
            $gameMessage.add('Rolled: ' + loc.name + ' (x' + loc.multiplier + ')');
        } else {
            $gameMessage.add('No battler found for test');
        }
    }

    if (command === 'TDarn_Diagnostic') {
        console.log('=== BATTLE DIAGNOSTIC ===');
        console.log('In battle:', $gameParty.inBattle());
        if ($gameParty.inBattle()) {
            console.log('Battle phase:', BattleManager._phase);
            console.log('Actor index:', BattleManager._actorIndex);
            console.log('Current actor:', BattleManager.actor() ? BattleManager.actor().name() : 'none');
            console.log('Action battlers:', BattleManager._actionBattlers ? BattleManager._actionBattlers.map(b => b.name()) : 'none');
            console.log('Subject:', BattleManager._subject ? BattleManager._subject.name() : 'none');
            console.log('Action state:', BattleManager.actor() ? BattleManager.actor()._actionState : 'none');
        }
    }
};

//=============================================================================
// Game_Actor/Enemy Extensions
//=============================================================================

Game_Actor.prototype.weapons = function() {
    return this.equips().filter(item => item && DataManager.isWeapon(item));
};

Game_Actor.prototype.armors = function() {
    return this.equips().filter(item => item && DataManager.isArmor(item));
};

Game_Enemy.prototype.weapons = function() {
    return [];
};

Game_Enemy.prototype.armors = function() {
    return [];
};

Game_Enemy.prototype.name = function() {
    return this.enemy().name;
};

Game_Enemy.prototype.level = function() {
    return 1;
};

// Yanfly BattleEngineCore compatibility: Window_BattleEnemy.updateHelp calls
// currentAction().needsSelection() which crashes if currentAction() is null.
// This happens when the enemy window is activated before the actor has set
// an action (e.g. during Move, or during Yanfly's display refresh calls).
// Guard against null to prevent the TypeError crash.
if (typeof Window_BattleEnemy !== 'undefined' &&
    Window_BattleEnemy.prototype.updateHelp) {
    var _Window_BattleEnemy_updateHelp = Window_BattleEnemy.prototype.updateHelp;
    Window_BattleEnemy.prototype.updateHelp = function() {
        var actor = BattleManager.actor();
        if (actor && !actor.currentAction()) return; // no action yet, skip
        _Window_BattleEnemy_updateHelp.call(this);
    };
}

console.log('T-Darn Combat System loaded successfully!');

})();