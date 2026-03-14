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
// Capture onSkillOk ONCE here at load time, before any overrides.
// This is the Yanfly version (or vanilla if no Yanfly), saved as our base.
const _Scene_Battle_onSkillOk_BASE = Scene_Battle.prototype.onSkillOk;

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
        1: { name: 'Head',  multiplier: 2,   range: [1,2],   armorType: 'head'  },
        2: { name: 'Body',  multiplier: 1,   range: [3,10],  armorType: 'torso' },
        3: { name: 'Wings', multiplier: 0.5, range: [11,15], armorType: 'legs'  },  // 'legs' armorType reserved for movement penalties on winged non-humanoids
        4: { name: 'Legs',  multiplier: 0.5, range: [16,20], armorType: 'arms'  }
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
            // Trim whitespace — note tags can have trailing spaces
            return enemy.meta.creatureType.trim();
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

var getWeaponSkill = function(weapon) {
    if (!weapon) return 0;
    const meta = weapon.meta;
    return parseInt(meta.weaponSkill) || 0;
};

var getDamageDice = function(weapon) {
    if (!weapon) return 1;
    const meta = weapon.meta;
    return parseInt(meta.damageDice) || 1;
};

var getWeaponDamage = function(weapon) {
    if (!weapon) return { dice: 1, sides: 4 }; // Unarmed: 1d4
    
    const meta = weapon.meta;
    
    if (meta && meta.damage) {
        const match = meta.damage.match(/(\d+)d(\d+)/i);
        if (match) {
            return {
                dice: parseInt(match[1]),
                sides: parseInt(match[2])
            };
        }
    }
    
    const dice = parseInt(meta && meta.damageDice) || 1;
    return { dice: dice, sides: 6 };
};

var getArmorAtLocation = function(armors, location) {
    for (let i = 0; i < armors.length; i++) {
        const armor = armors[i];
        if (armor && armor.meta && armor.meta.armorLocation === location) {
            const value = parseInt(armor.meta.armorStrength);
            return isNaN(value) ? 0 : value;
        }
    }
    return 0;
};

//=============================================================================
// Weapon Range System
// Range bands (book terminology): Point Blank / Short / Medium / Long / Extreme
// Tag each weapon in its Notes box: <range: Short>
// Unarmed (no weapon) is Short range only. Untagged weapons have no restriction.
//=============================================================================

// Returns the range band from a weapon's <range: X> note tag.
// Returns the range band from a weapon's <range: X> note tag only.
// No tag (including unarmed) = null = no restriction.
// Weapon type IDs → default range when no <range:> tag is present.
var getWeaponRange = function(weapon) {
    if (!weapon) return 'short';                                   // unarmed = Short
    if (weapon.meta && weapon.meta.range) return weapon.meta.range.trim().toLowerCase();
    return null;                                                   // no tag = no restriction
};

// Returns true if the attack is within valid range.
// Only restricts if the weapon has a <range: X> tag. No tag = always valid.
var isInValidRange = function(attacker, target) {
    var weapon = attacker.weapons ? attacker.weapons()[0] : null;
    var rangeClass = getWeaponRange(weapon);
    if (!rangeClass) return true;
    var distance = getRangeDistance(attacker, target);
    var minDist = TDarn.RANGE_MINIMUMS[rangeClass] !== undefined ? TDarn.RANGE_MINIMUMS[rangeClass] : 0;
    var maxDist = TDarn.RANGE_MAXIMUMS[rangeClass] !== undefined ? TDarn.RANGE_MAXIMUMS[rangeClass] : 4;
    return distance >= minDist && distance <= maxDist;
};


var getRecoil = function(weapon) {
    if (!weapon) return 0;
    const meta = weapon.meta;
    return parseInt(meta.recoil) || 0;
};

//=============================================================================
// Game_Action Overrides
//=============================================================================

Game_Action.prototype.isMeleeAttack = function() {
    const subject = this.subject();
    if (!subject) return true;
    const weapon = subject.weapons ? subject.weapons()[0] : null;
    return !getWeaponRange(weapon);  // melee = no range tag
};

Game_Action.prototype.apply = function(target) {
    const subject = this.subject();
    if (!subject) return;
    
    // Guard: self-target guard action = Move no-op. Skip all combat logic.
    if (subject === target && this.isGuard && this.isGuard()) {
        target.result().clear();
        return;
    }
    
    const skill = this.item();
    const weapon = subject.weapons ? subject.weapons()[0] : null;

    // Spell or POW-using ability: has spellLevel OR spellType tag
    var _isSpellAction = skill && skill.meta && (skill.meta.spellLevel || skill.meta.spellType);
    // Only Attack/Chi spells use the attack roll path. Regenerate/Shield are routed separately.
    var _spellTypeTag  = _isSpellAction && skill.meta.spellType ? skill.meta.spellType.trim() : '';
    var _isAttackSpell = _isSpellAction && (_spellTypeTag === 'Attack' || _spellTypeTag === 'Chi' || _spellTypeTag === '');

    // Range validity check for physical attacks only
    if (!_isSpellAction && subject.isActor && subject.isActor() !== target.isActor()) {
        // If the target changed column since being selected, the attack misses — they moved away
        var targetMovedAway = (target._columnAtTargeting !== undefined &&
                               target._columnAtTargeting !== target.battlePosition());
        if (targetMovedAway) {
            console.log('[RANGE] ' + target.name() + ' moved away — committed attack misses');
            $gameMessage.add(target.name() + ' evaded!');
            target._columnAtTargeting = undefined;
            target.result().missed = true;
            target.result().hpAffected = false;
            target.startDamagePopup();
            return;
        }
        target._columnAtTargeting = undefined;

        if (!isInValidRange(subject, target)) {
            // Auto-advance is handled in processTurn before startAction fires.
            // If we somehow reach here, just clear and return — no attack.
            target.result().clear();
            return;
        }
    }
    if (_isAttackSpell) {
        const baseLevel  = skill.meta.spellLevel ? parseInt(skill.meta.spellLevel) : 1;
        const _powLevel  = subject.powerLevel ? subject.powerLevel() : 0;
        // _selectedSpellLevel is already the full cast level (skill portion + POW included).
        // Falls back to baseLevel + POW if no selection was made (e.g. auto-battle).
        const _castLevel = subject._selectedSpellLevel
            ? subject._selectedSpellLevel
            : baseLevel + _powLevel;
        var _spellType   = skill.meta.spellType ? skill.meta.spellType.trim() : 'Magic';
        var _spellAtkPen = TDarn.getAttackPenalty(subject, _spellType);
        var _spellDefPen = TDarn.getDefensePenalty(target);
        const attackRoll  = Math.floor(Math.random() * 20) + 1 + _castLevel + _spellAtkPen;
        const defenseRoll = Math.floor(Math.random() * 20) + 1 + target.agi + _spellDefPen;
        const isNatural20 = (attackRoll - _castLevel - _spellAtkPen) === 20;
        
        if (subject._interrupted) {
            console.log(subject.name() + "'s spell was interrupted!");
            $gameMessage.add(subject.name() + "'s spell was interrupted!");
            subject._interrupted = false;
            target.result().missed = true;
            target.result().clear();
            return;
        }
        
        const distance = getRangeDistance(subject, target);
        const rangeMod = getRangeModifier(distance);
        const finalAttackRoll = attackRoll + rangeMod;

        console.log(subject.name() + ' casting spell at ' + target.name() +
                    ' | Cast Level: ' + _castLevel +
                    ' | Attack: ' + attackRoll +
                    ' | Final: ' + finalAttackRoll +
                    ' | Defense: ' + defenseRoll);

        // Spell roll display — dice above attacker and defender
        (function() {
            var rawAtk = attackRoll - _castLevel - _spellAtkPen;
            var rawDef = defenseRoll - target.agi - _spellDefPen;
            var outcome = (finalAttackRoll > defenseRoll || isNatural20)
                ? (isNatural20 ? 'CRIT SPELL' : 'SPELL HITS') : 'SPELL MISS';
            var atkMods = [{label: 'Lv', val: _castLevel}];
            if (_spellAtkPen) atkMods.push({label: 'Pen', val: _spellAtkPen});
            if (rangeMod)     atkMods.push({label: 'Rng', val: rangeMod});
            var defMods = [{label: 'AGI', val: target.agi}];
            if (_spellDefPen) defMods.push({label: 'Pen', val: _spellDefPen});
            TDarn.showRoll({
                attacker: subject,
                defender: target,
                rolls: [
                    {die: 20, raw: rawAtk, mods: atkMods, total: finalAttackRoll, label: 'Cast'},
                    {die: 20, raw: rawDef, mods: defMods, total: defenseRoll,     label: 'Defense'}
                ],
                result: outcome,
                detail: ''
            });
        })();

        if (finalAttackRoll > defenseRoll || isNatural20) {
            // Check if target actor can intercept with Shield (not Chi attacks)
            var _canShield = target.isActor && target.isActor() &&
                !target.hasActiveShield() &&
                _spellTypeTag !== 'Chi' &&
                target.tdarnSkillLevel && target.tdarnSkillLevel('Shield') > 0 &&
                target.spellEnergy && target.spellEnergy() >= 1;
            if (_canShield) {
                BattleManager._pendingSpellDamage   = { action: this, target: target, isNatural20: isNatural20, skill: skill };
                BattleManager._shieldInterceptActor = target;
                BattleManager._phase = 'shieldWait';
                $gameMessage.add(target.name() + ' is targeted by a spell! Activate Shield?');
                var _scene = SceneManager._scene;
                if (_scene && _scene.showShieldIntercept) _scene.showShieldIntercept(target);
            } else {
                this.applySpellDamage(target, isNatural20, skill);
            }
        } else {
            this.checkParry(target);
        }
        return;
    }

    // Non-attack spells: no attack roll needed
    if (_isSpellAction) {
        if (_spellTypeTag === 'Regenerate') {
            this.applyRegenerateSpell(target, skill);
            return;
        }
        if (_spellTypeTag === 'Shield') {
            this.applyShieldSpell(target, skill);
            return;
        }
    }

    // Normal melee/ranged attack
    var _wSkill     = getWeaponSkill(weapon);
    var _wType      = getWeaponType(weapon) || 'Unarmed';
    var _atkPenalty = TDarn.getAttackPenalty(subject, _wType);
    var _defPenalty = TDarn.getDefensePenalty(target);
    const attackRoll  = Math.floor(Math.random() * 20) + 1 + subject.agi + _wSkill + _atkPenalty;
    const defenseRoll = Math.floor(Math.random() * 20) + 1 + target.agi + _defPenalty;
    const isNatural20 = (attackRoll - subject.agi - _wSkill - _atkPenalty) === 20;
    
    const distance = getRangeDistance(subject, target);
    const rangeMod = getRangeModifier(distance);
    const finalAttackRoll = attackRoll + rangeMod;

    var _penNote = (_atkPenalty || _defPenalty) ? ' | Penalties: atk' + _atkPenalty + '/def' + _defPenalty : '';
    console.log(subject.name() + ' attacking ' + target.name() + 
                ' | Distance: ' + distance + 
                ' | Range Mod: ' + rangeMod + 
                ' | Attack Roll: ' + attackRoll + 
                ' | Final: ' + finalAttackRoll + 
                ' | Defense: ' + defenseRoll + _penNote);

    // Roll display — d20 shapes above attacker and defender
    (function() {
        var skillBonus = getWeaponSkill(weapon);
        var rawAtk     = attackRoll - subject.agi - skillBonus - _atkPenalty;
        var rawDef     = defenseRoll - target.agi - _defPenalty;
        var outcome    = (finalAttackRoll > defenseRoll || isNatural20)
            ? (isNatural20 ? 'CRIT' : 'HIT') : 'MISS';
        var atkMods = [{label: 'AGI', val: subject.agi}];
        if (skillBonus)  atkMods.push({label: 'Skill', val: skillBonus});
        if (rangeMod)    atkMods.push({label: 'Rng',   val: rangeMod});
        if (_atkPenalty) atkMods.push({label: 'Pen',   val: _atkPenalty});
        var defMods = [{label: 'AGI', val: target.agi}];
        if (_defPenalty) defMods.push({label: 'Pen',   val: _defPenalty});
        TDarn.showRoll({
            attacker: subject,
            defender: target,
            rolls: [
                {die: 20, raw: rawAtk, mods: atkMods, total: finalAttackRoll, label: 'Attack'},
                {die: 20, raw: rawDef, mods: defMods, total: defenseRoll,     label: 'Defense'}
            ],
            result:  outcome,
            detail:  weapon ? weapon.name : 'Unarmed'
        });
    })();

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
        target.result().evaded = false;
        
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
        
        const finalDamage = Math.max(0, Math.floor(damage / 2));
        
        target.result().hpDamage   = finalDamage;
        target.result().hpAffected = true;
        if (finalDamage > 0) target.gainHp(-finalDamage);
        target.startDamagePopup();
        
        console.log('PARRY: ' + target.name() + ' takes half damage (' + finalDamage + ')');
    } else {
        target.result().missed = true;
        target.result().clear();
    }
};

//=============================================================================
// Power Level / Spell Energy
//=============================================================================

// POW lives in param(1) — the MMP slot, repurposed.
// Set POW in Database → Actors/Classes → Parameters, MMP column.
// Enemies read POW from <pow: N> note tag.
Game_Actor.prototype.tdarnPow   = function() { return this.param(1); };
Game_Actor.prototype.powerLevel = function() { return this.param(1); };

Game_Enemy.prototype.tdarnPow   = function() { return parseInt(this.enemy().meta.pow) || 0; };
Game_Enemy.prototype.powerLevel = function() { return this.tdarnPow(); };

// ── Spell Energy pool (POW * 10) ─────────────────────────────────────────
// Separate from MV MP. Tracked as _spellEnergy on each magic-capable actor.
// Initialised to POW*10 on setup. Costs chosen cast level per spell.
// Recovers at 1 per hour (approximated as 1 per 60 steps in overworld).

Game_Actor.prototype.spellEnergyMax = function() {
    return this.tdarnPow() * 10;
};

Game_Actor.prototype.spellEnergy = function() {
    if (this._spellEnergy === undefined) this._spellEnergy = this.spellEnergyMax();
    return this._spellEnergy;
};

Game_Actor.prototype.consumeSpellEnergy = function(amount) {
    if (this._spellEnergy === undefined) this._spellEnergy = this.spellEnergyMax();
    this._spellEnergy = Math.max(0, this._spellEnergy - amount);
    console.log('[SE] ' + this.name() + ' spent ' + amount + ' SE — remaining: ' + this._spellEnergy + '/' + this.spellEnergyMax());
};

Game_Actor.prototype.restoreSpellEnergy = function(amount) {
    if (this._spellEnergy === undefined) this._spellEnergy = this.spellEnergyMax();
    this._spellEnergy = Math.min(this.spellEnergyMax(), this._spellEnergy + amount);
};

const _Game_Actor_deserialize = Game_Actor.prototype.deserialize;
Game_Actor.prototype.deserialize = function(data) {
    _Game_Actor_deserialize.call(this, data);
    this._spellEnergy         = data._spellEnergy;
    this._defaultBattleColumn = data._defaultBattleColumn;
    this._battleColumn        = data._battleColumn;
    this._tdarnSkills         = data._tdarnSkills   || {};
    this._tdarnSkillSp        = data._tdarnSkillSp  || {};
};

// Recover 1 SE per 60 steps. Each 2 steps = 1 minute dead (0.5 min/step).
const _Game_Actor_onPlayerWalk = Game_Actor.prototype.onPlayerWalk;
Game_Actor.prototype.onPlayerWalk = function() {
    _Game_Actor_onPlayerWalk.call(this);
    if ($gameParty.steps() % 60 === 0) {
        this.restoreSpellEnergy(1);
    }
    // Dead actors accumulate dead-time out of battle (every 2 steps = 1 turn = 0.5 min)
    if (this.isDead() && $gameParty.steps() % 2 === 0) {
        this.incrementDeadTime();
    }
};

//=============================================================================
// Hit Application
//=============================================================================

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
    
    let finalDamage = Math.max(0, damage - Math.floor(armorStrength / 2));
    
    if (isNatural20) {
        finalDamage *= 2;
    }
    
    finalDamage = Math.floor(finalDamage * hitLocation.multiplier);
    
    if (isNaN(finalDamage) || !isFinite(finalDamage)) finalDamage = 1;
    if (finalDamage < 1) finalDamage = 1;

    // Shield absorbs all physical damage
    if (target.hasActiveShield && target.hasActiveShield()) {
        finalDamage = target.absorbWithShield(finalDamage);
    }

    target.result().clear();
    target.result().hpDamage = finalDamage > 0 ? finalDamage : 0;
    target.result().hpAffected = true;
    if (finalDamage > 0) target.gainHp(-finalDamage);
    target.result().hitLocation = hitLocation.name;
    
    if (isNatural20) {
        target.result().critical = true;
        // Track for enemy AI: which enemy dealt a crit this turn
        if (subject.isEnemy && subject.isEnemy()) {
            BattleManager._lastCritEnemy = subject;
            console.log('[AI] Critical hit recorded for enemy AI: ' + subject.name());
        }
    }
    
    target.startDamagePopup();
    
    console.log('HIT: ' + subject.name() + ' -> ' + target.name() + 
                ' | Location: ' + hitLocation.name + 
                ' | Damage: ' + finalDamage +
                (isNatural20 ? ' | CRITICAL!' : ''));

    // Damage die above attacker
    (function() {
        var mods = [];
        if (armorStrength > 0) mods.push({label: 'Armor', val: -Math.floor(armorStrength / 2)});
        if (isNatural20)       mods.push({label: 'CRITx2', val: 0});
        TDarn.showRoll({
            attacker: subject,
            defender: target,
            rolls: [{die: weaponDamage.sides, raw: damage, mods: mods, total: finalDamage,
                     label: weaponDamage.dice + 'd' + weaponDamage.sides}],
            result: isNatural20 ? 'CRIT' : 'HIT',
            detail: hitLocation.name + ' x' + hitLocation.multiplier + ' = ' + finalDamage
        });
    })();
};


//=============================================================================
// Shield Spell System
//
// _shieldPool: remaining absorption capacity of active shield.
// _shieldMax:  pool at cast time (cast level × 10).
// Absorbs incoming spell damage (not Chi, not weapon attacks).
// Shatters when pool reaches 0.
// One shield per actor at a time.
//=============================================================================

Game_Battler.prototype.hasActiveShield = function() {
    return this._shieldPool !== undefined && this._shieldPool > 0;
};

Game_Battler.prototype.activateShield = function(castLevel) {
    this._shieldMax  = castLevel * 10;
    this._shieldPool = this._shieldMax;
    console.log('[SHIELD] ' + this.name() + ' shield activated: ' + this._shieldPool + ' HP');
};

Game_Battler.prototype.dropShield = function() {
    this._shieldPool = 0;
    this._shieldMax  = 0;
    console.log('[SHIELD] ' + this.name() + ' shield dropped');
};

// Absorb incoming spell damage. Returns remaining damage after shield.
Game_Battler.prototype.absorbWithShield = function(damage) {
    if (!this.hasActiveShield()) return damage;
    var absorbed = Math.min(this._shieldPool, damage);
    this._shieldPool -= absorbed;
    var remaining = damage - absorbed;
    console.log('[SHIELD] ' + this.name() + ' shield absorbed ' + absorbed +
        ' dmg — pool: ' + this._shieldPool + '/' + this._shieldMax);
    if (this._shieldPool <= 0) {
        this._shieldPool = 0;
        console.log('[SHIELD] ' + this.name() + ' shield shattered!');
        $gameMessage.add(this.name() + "'s shield shatters!");
    }
    return remaining;
};


//=============================================================================
// Regenerate Spell — heals 1 HP per cast level. Revives dead targets.
//
// Heal: target._healedThisWound prevents double-healing same wound.
//       Resets when target takes damage again.
// Revive: roll d20 < (castLevel - minutesDead). One attempt per death.
//         _reviveAttempted flag prevents second tries.
//=============================================================================

// Regenerate spell note tag: <regenType: heal>   — heals only (cannot revive)
//                            <regenType: revive> — revives dead only (no heal on living)
//                            <regenType: both>   — heals living AND revives dead (default)
Game_Action.prototype.applyRegenerateSpell = function(target, skill) {
    var subject   = this.subject();
    var castLevel = subject._selectedSpellLevel || 1;
    var regenType = skill.meta.regenType ? skill.meta.regenType.trim().toLowerCase() : 'both';

    // ── REVIVE PATH (target is dead) ────────────────────────────────────
    if (target.isDead()) {
        if (regenType === 'heal') {
            $gameMessage.add('This regeneration spell cannot revive the dead!');
            target.result().clear();
            return;
        }
        // One attempt PER CASTER per dead target. Tracked on the CASTER.
        if (!subject._reviveAttempts) subject._reviveAttempts = {};
        var tId = target.actorId ? target.actorId() : (target.enemyId ? target.enemyId() : -1);
        if (subject._reviveAttempts[tId]) {
            $gameMessage.add(subject.name() + ' has already used their one revive attempt on ' + target.name() + '!');
            target.result().clear();
            return;
        }
        subject._reviveAttempts[tId] = true;

        var minutes = target.minutesDead ? target.minutesDead() : 0;
        var dc      = castLevel - minutes;
        var roll    = Math.floor(Math.random() * 20) + 1;
        var success = roll < dc;

        console.log('[REVIVE] ' + subject.name() + ' attempts to revive ' + target.name() +
            ' | Cast Lv: ' + castLevel + ' | Minutes dead: ' + minutes +
            ' | DC: ' + dc + ' | Roll: ' + roll + ' | ' + (success ? 'SUCCESS' : 'FAIL'));

        TDarn.showRoll({
            attacker: subject,
            defender: target,
            rolls: [{die: 20, raw: roll, mods: [{label: 'Need <' + dc, val: 0}], total: roll, label: 'Revive'}],
            result: success ? 'REVIVED' : 'MISS',
            detail: 'Lv' + castLevel + ' - ' + minutes + ' min = DC ' + dc
        });

        if (success) {
            target.clearDeadTime();
            target.setHp(1);
            target.result().hpDamage   = -1;
            target.result().hpAffected = true;
            $gameMessage.add(target.name() + ' has been revived!');
        } else {
            target.result().clear();
            $gameMessage.add('The revive attempt on ' + target.name() + ' failed!');
        }
        target.startDamagePopup();
        return;
    }

    // ── HEAL PATH (target is alive) ──────────────────────────────────────
    if (regenType === 'revive') {
        $gameMessage.add('This spell can only revive the dead — ' + target.name() + ' is alive!');
        target.result().clear();
        return;
    }

    if (target._healedThisWound) {
        $gameMessage.add(target.name() + ' cannot be healed again until wounded!');
        target.result().clear();
        return;
    }

    var healAmount = castLevel;
    target._healedThisWound = true;

    target.result().clear();
    target.result().hpDamage   = -healAmount;
    target.result().hpAffected = true;
    target.gainHp(healAmount);
    target.startDamagePopup();

    console.log('[REGEN] ' + subject.name() + ' heals ' + target.name() + ' for ' + healAmount + ' HP');
    TDarn.showRoll({
        attacker: subject,
        defender: target,
        rolls: [{die: 6, raw: healAmount, mods: [], total: healAmount, label: 'Heal'}],
        result: 'REVIVED',
        detail: '+' + healAmount + ' HP'
    });
};

// Reset heal-lock when target takes damage
var _Game_Battler_gainHp_regen = Game_Battler.prototype.gainHp;
Game_Battler.prototype.gainHp = function(value) {
    var wasDead = this.isDead();
    _Game_Battler_gainHp_regen.call(this, value);
    if (value < 0 && this._healedThisWound) {
        this._healedThisWound = false;
    }
    // If this battler just came back from the dead (by any means),
    // clear all casters' revive attempt records for them.
    if (wasDead && !this.isDead()) {
        var myId = this.actorId ? this.actorId() : (this.enemyId ? this.enemyId() : -1);
        var allBattlers = ($gameParty ? $gameParty.members() : [])
            .concat($gameTroop ? $gameTroop.members() : []);
        allBattlers.forEach(function(b) {
            if (b._reviveAttempts && b._reviveAttempts[myId]) {
                delete b._reviveAttempts[myId];
            }
        });
    }
};

//=============================================================================
// Shield Spell — activates a damage-absorbing shield on the target.
// Shield pool = cast level × 10.
// Only one shield active per actor at a time (replaces existing).
//=============================================================================

Game_Action.prototype.applyShieldSpell = function(target, skill) {
    var subject   = this.subject();
    var castLevel = subject._selectedSpellLevel || 1;

    target.activateShield(castLevel);

    var pool = castLevel * 10;
    target.result().clear();
    $gameMessage.add(target.name() + "'s shield activated! (" + pool + " HP protection)");
    TDarn.showRoll({
        attacker: subject,
        defender: target,
        rolls: [{die: 6, raw: castLevel, mods: [{label: 'x10', val: 0}], total: pool, label: 'Shield'}],
        result: 'HIT',
        detail: pool + ' HP pool'
    });
};

//=============================================================================
// Spell Damage
//=============================================================================

Game_Action.prototype.applySpellDamage = function(target, isNatural20, skill) {
    const subject = this.subject();
    const baseLevel  = skill.meta.spellLevel ? parseInt(skill.meta.spellLevel) : 1;
    const powerLevel = subject.powerLevel ? subject.powerLevel() : 0;
    // _selectedSpellLevel is the full level chosen from the window (already includes POW).
    const actualLevel = subject._selectedSpellLevel || (baseLevel + powerLevel);
    
    const hitLocation = determineHitLocation(target);
    
    let damage = 0;
    for (let i = 0; i < actualLevel; i++) {
        damage += Math.floor(Math.random() * 6) + 1;
    }
    
    let finalDamage = damage;
    
    if (isNatural20) {
        finalDamage *= 2;
    }
    
    finalDamage = Math.floor(finalDamage * hitLocation.multiplier);
    
    if (finalDamage < 1) finalDamage = 1;

    // Shield absorbs all spell damage (including Chi)
    if (target.hasActiveShield && target.hasActiveShield()) {
        finalDamage = target.absorbWithShield(finalDamage);
    }

    target.result().clear();
    target.result().hpDamage = finalDamage > 0 ? finalDamage : 0;
    target.result().hpAffected = true;
    if (finalDamage > 0) target.gainHp(-finalDamage);
    target.result().hitLocation = hitLocation.name;
    
    if (isNatural20) {
        target.result().critical = true;
    }
    
    target.startDamagePopup();
    
    console.log(subject.name() + "'s spell hit " + target.name() + 
                ' for ' + finalDamage + ' damage | Location: ' + hitLocation.name);

    TDarn.showRoll({
        attacker: subject,
        defender: target,
        rolls: [{die: 6, raw: finalDamage, mods: isNatural20 ? [{label: 'CRIT x2', val: 0}] : [],
                 total: finalDamage, label: actualLevel + 'd6'}],
        result: isNatural20 ? 'CRIT' : 'HIT',
        detail: hitLocation.name + ' (x' + hitLocation.multiplier + ')  ' + finalDamage + ' dmg'
    });
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
// Spell Interruption System
//=============================================================================

const _Game_Action_executeDamage = Game_Action.prototype.executeDamage;
Game_Action.prototype.executeDamage = function(target, value) {
    _Game_Action_executeDamage.call(this, target, value);
    
    const subject = this.subject();
    if (subject && subject.isActor()) {
        if (target._isCasting) {
            if (Math.random() < 0.5) {
                target._interrupted = true;
                console.log(target.name() + "'s spell was interrupted!");
            }
        }
    }
};

const _BattleManager_endTurn = BattleManager.endTurn;
BattleManager.endTurn = function() {
    this.allBattleMembers().forEach(function(battler) {
        battler._isCasting = false;
        battler._interrupted = false;
    });
    _BattleManager_endTurn.call(this);
};

//=============================================================================
// Spell Level Window
//=============================================================================

function Window_SpellLevel() {
    this.initialize.apply(this, arguments);
}

Window_SpellLevel.prototype = Object.create(Window_Command.prototype);
Window_SpellLevel.prototype.constructor = Window_SpellLevel;

Window_SpellLevel.prototype.initialize = function(x, y) {
    Window_Command.prototype.initialize.call(this, x, y);
    this._skill = null;
    this._actor = null;
    this.deactivate();
    this.select(-1);
};

Window_SpellLevel.prototype.windowWidth = function() {
    return 250;
};

Window_SpellLevel.prototype.makeCommandList = function() {
    if (!this._skill || !this._actor) {
        this.addCommand('Selecting spell...', 'cancel', false);
        return;
    }
    
    let powerLevel = 0;
    try {
        powerLevel = this._actor.powerLevel ? this._actor.powerLevel() : 0;
    } catch (e) {
        powerLevel = 0;
    }
    
    // Max cast level = spell skill level + POW.
    // Spell Energy pool = POW * 10. Cost = chosen cast level.
    const spellType  = this._skill.meta.spellType ? this._skill.meta.spellType.trim() : 'Magic';
    const skillLevel = this._actor.tdarnSkillLevel ? this._actor.tdarnSkillLevel(spellType) : 1;
    const maxLevel   = skillLevel + powerLevel;  // e.g. Chi 2 + POW 2 = max 4
    const sePool     = this._actor.spellEnergy !== undefined
        ? this._actor.spellEnergy() : 0;

    for (let i = 1; i <= maxLevel; i++) {
        const cost   = i;
        const canUse = sePool >= cost;
        const label  = 'Level ' + i + '  (cost: ' + cost + ' SE  pool: ' + sePool + ')';
        this.addCommand(label, 'level' + i, canUse);
    }
    if (maxLevel === 0) {
        this.addCommand('No spell levels available', 'cancel', false);
    }
};

Window_SpellLevel.prototype.setSkill = function(skill, actor) {
    this._skill = skill;
    this._actor = actor;
    this.refresh();
};

//=============================================================================
// Spell Level Selection — onSkillOk / onSpellLevelSelect
//
// Flow:
//   Actor selects a spell in Window_BattleSkill
//   → onSkillOk fires
//   → If spell, hide skill/command windows, show spell level window
//   → Actor picks a level → onSpellLevelSelect(level) fires
//   → Store level on actor, hide spell level window
//   → Call BattleManager.inputtingAction().setSkill() directly
//     (bypasses Yanfly's onSkillOk which calls inputtingAction() — safe
//      because we do it while the actor is still the inputting actor)
//   → Call selectEnemySelection() or selectActorSelection() for target pick
//
// Why NOT call _Scene_Battle_onSkillOk_BASE from onSpellLevelSelect:
//   Yanfly's onSkillOk calls BattleManager.actor().inputtingAction() which
//   works during the skill window phase, but by the time onSpellLevelSelect
//   fires the actor command/skill windows have been torn down and actor()
//   may return null or have no inputtingAction, causing the crash.
//=============================================================================

Scene_Battle.prototype.onSkillOk = function() {
    const skill = this._skillWindow.item();
    const actor = BattleManager.actor();
    
    var _isSpell = skill && skill.meta && (skill.meta.spellLevel || skill.meta.spellType);
    if (_isSpell && !this._skipSpellLevelCheck) {
        // Spell or POW-using ability — intercept and show POW charge picker first.
        this._skillWindow.deactivate();
        this._skillWindow.hide();
        this._actorCommandWindow.deactivate();
        this._actorCommandWindow.hide();
        
        this._spellLevelWindow.setSkill(skill, actor);
        this._spellLevelWindow.show();
        this._spellLevelWindow.activate();
        this._spellLevelWindow.select(0);
        
        console.log('Spell level window activated');
    } else {
        // Normal skill or second pass (after spell level chosen) — use base flow.
        _Scene_Battle_onSkillOk_BASE.call(this);
    }
};

Scene_Battle.prototype.onSpellLevelCancel = function() {
    this._spellLevelWindow.hide();
    this._spellLevelWindow.deactivate();
    this._skillWindow.show();
    this._skillWindow.activate();
    this._actorCommandWindow.show();
};

Scene_Battle.prototype.onSpellLevelSelect = function(level) {
    const actor = this._spellLevelWindow._actor;
    const skill = this._spellLevelWindow._skill;
    
    if (!actor || !skill) {
        console.log('SpellLevel: No actor or skill, cancelling');
        this._spellLevelWindow.hide();
        this._spellLevelWindow.deactivate();
        this._skillWindow.show();
        this._skillWindow.activate();
        return;
    }
    
    console.log('Spell level ' + level + ' selected for ' + actor.name());
    
    // Tear down spell level window completely.
    this._spellLevelWindow.deactivate();
    this._spellLevelWindow.hide();
    this._spellLevelWindow.active = false;
    
    // Store chosen level on actor so applySpellDamage can use it.
    actor._selectedSpellLevel = level;
    actor._isCasting = true;
    
    // Deduct chosen level from Spell Energy pool (not MV MP).
    const powerLevel = actor.powerLevel ? actor.powerLevel() : 0;
    if (actor.consumeSpellEnergy) actor.consumeSpellEnergy(level);
    skill.mpCost = 0;  // zero out MV MP cost — SE pool handles resource tracking
    
    // Commit the skill to the actor's current action directly.
    // We must do this while actor is still the inputting actor.
    // Yanfly's onSkillOk does: inputtingAction().setSkill(skill.id) then
    // routes to target selection. We replicate just that essential part.
    var action = actor.inputtingAction();
    if (!action) {
        // Fallback: actor has no inputting action (shouldn't happen, but guard it)
        console.log('SpellLevel: inputtingAction is null, falling back');
        this._skillWindow.show();
        this._skillWindow.activate();
        return;
    }
    
    action.setSkill(skill.id);
    
    // Now route to target selection based on skill scope.
    // skill.scope: 1=one enemy, 2=all enemies, 7=one ally, 8=all allies, etc.
    if (skill.scope === 1 || skill.scope === 2 || skill.scope === 5 || skill.scope === 6) {
        // Enemy targets
        this.selectEnemySelection();
    } else if (skill.scope === 7 || skill.scope === 8 || skill.scope === 9 || skill.scope === 10) {
        // Ally targets  
        this.selectActorSelection();
    } else {
        // No target needed (scope 11 = everyone, or self) — call base onSkillOk
        // with flag set so it skips the spell intercept.
        this._skipSpellLevelCheck = true;
        this._skillWindow.show();
        this._skillWindow.activate();
        _Scene_Battle_onSkillOk_BASE.call(this);
        this._skipSpellLevelCheck = false;
    }
};


//=============================================================================
// Dice Roll Display System
//
// Window_DiceRoll: a queue-based overlay that shows formatted roll results.
// Each entry displays for ~180 frames (~3 seconds at 60fps) then fades out.
// New entries stack vertically and scroll up as old ones expire.
//
// TDarn.showRoll(lines) — the single public API.
//   lines: array of strings, e.g.:
//     ['Harold attacks Punk', 'd20+4 = 17  vs  d20+2 = 11', '→ HIT (Torso)']
//
// Called from: initiative roll, attack apply, spell apply, damage rolls.
//=============================================================================

// Allow 6 actors in battle (MV core hardcodes 4).
// Place this before YEP_BattleEngineCore in the plugin list if it conflicts,
// or after — YEP defers to this value either way.
Game_Party.prototype.maxBattleMembers = function() {
    return 6;
};

var TDarn = TDarn || {};

// Weapon type IDs → default range when no <range:> tag is present.
// Guns/bows should be tagged in DB. Melee defaults to medium.
// null = no restriction for unrecognised types.
// Weapon ranges are set via <range: X> note tag on each weapon.
// Unarmed (no weapon) is Short. Tagged weapons use their tag. No tag = no range restriction.

// Minimum and maximum column-separation per range band (book terminology).
TDarn.RANGE_MINIMUMS = {
    'point blank': 0,
    'short':       0,
    'medium':      1,
    'long':        2,
    'extreme':     3,
};
TDarn.RANGE_MAXIMUMS = {
    'point blank': 0,
    'short':       1,
    'medium':      2,
    'long':        3,
    'extreme':     4,
};

// Returns true if any living enemy is within valid range for this actor's weapon.
TDarn.hasValidTarget = function(actor) {
    var enemies = $gameTroop.aliveMembers();
    return enemies.some(function(e) { return isInValidRange(actor, e); });
};

//=============================================================================
// T-DARN CONTEXT & PENALTY SYSTEM
//
// Penalties are TRAIT-GATED: a penalty only affects a battler if that
// battler has a matching trait tag in their actor/enemy note box.
// No trait match = no penalty, regardless of what the troop or event says.
// Multiple penalty sources never stack — the worst single value wins.
//
// ── Actor / Enemy note tag ────────────────────────────────────────────────
//   <trait: technophobe>               one trait
//   <trait: technophobe, clumsy>       multiple traits, comma-separated
//   Can also use states — any state with <trait: X> note applies too.
//
// ── Troop note tag syntax ─────────────────────────────────────────────────
//   <penalty: INT -1 if:technophobe>   -1 INT to battlers with technophobe
//   <penalty: AGI -2 if:clumsy>        -2 AGI rolls to clumsy battlers
//   <penalty: skill:Stealth -1 if:clumsy>
//   Multiple tags, one per line. Only applies during that battle.
//
// ── Script call syntax (inside events) ───────────────────────────────────
//   TDarn.setContextPenalty('INT', -1, 'technophobe');
//   TDarn.setContextPenalty('SOC', -2, 'hostile_crowd');
//   TDarn.clearContextPenalty('INT', 'technophobe');
//   TDarn.clearContext();   // clear all event penalties
//   Event penalties persist until cleared — useful across multi-page events.
//
// ── In-event checks ───────────────────────────────────────────────────────
//   TDarn.statCheck('INT', actorId, dc)
//   TDarn.skillCheck('Stealth', actorId, dc)
//   TDarn.enemyStatCheck('INT', enemyIndex, dc)  // for enemy battlers
//   Pass/fail → Variable LAST_CHECK_VAR (1=pass, 0=fail)
//   Roll total → Variable LAST_ROLL_VAR
//
// ── Stacking ──────────────────────────────────────────────────────────────
//   Penalties from multiple sources DO stack. A troop penalty and an event
//   penalty both applying to the same stat on the same battler will combine.
//   e.g. troop: INT -1 if:technophobe + event: INT -1 if:technophobe = -2 INT.
//=============================================================================

TDarn.LAST_CHECK_VAR = 1;  // Variable ID: pass(1) / fail(0)
TDarn.LAST_ROLL_VAR  = 2;  // Variable ID: roll total

// Penalty entries: array of { stat, value, trait } objects
TDarn._troopPenalties = [];   // loaded from troop notes, cleared each battle
TDarn._eventPenalties = [];   // set by script calls, cleared manually

// ── Trait helpers ─────────────────────────────────────────────────────────

// Get trait list for any battler (actor or enemy), including active states
TDarn.getBattlerTraits = function(battler) {
    var traits = [];
    var noteSource = null;
    if (battler.isActor && battler.isActor()) {
        noteSource = battler.actor ? battler.actor() : null;
    } else if (battler.isEnemy && battler.isEnemy()) {
        noteSource = battler.enemy ? battler.enemy() : null;
    }
    if (noteSource && noteSource.meta && noteSource.meta.trait) {
        noteSource.meta.trait.split(',').forEach(function(t) {
            var trimmed = t.trim().toLowerCase();
            if (trimmed) traits.push(trimmed);
        });
    }
    // Also check active states for trait tags
    if (battler.states) {
        battler.states().forEach(function(state) {
            if (state && state.meta && state.meta.trait) {
                state.meta.trait.split(',').forEach(function(t) {
                    var trimmed = t.trim().toLowerCase();
                    if (trimmed && traits.indexOf(trimmed) === -1) traits.push(trimmed);
                });
            }
        });
    }
    return traits;
};

TDarn.battlerHasTrait = function(battler, trait) {
    if (!trait) return true; // no trait requirement = applies to everyone
    return TDarn.getBattlerTraits(battler).indexOf(trait.toLowerCase()) !== -1;
};

// ── Penalty lookup for a specific battler + stat/skill key ────────────────
// Returns the worst (most negative) single penalty that applies to this battler.
// Never stacks — only the largest magnitude negative wins.
TDarn.getPenaltyFor = function(battler, key) {
    var k = key.trim();
    var worst = 0;
    var all = TDarn._troopPenalties.concat(TDarn._eventPenalties);
    for (var i = 0; i < all.length; i++) {
        var entry = all[i];
        if (entry.stat !== k) continue;
        if (!TDarn.battlerHasTrait(battler, entry.trait)) continue;
        worst += entry.value; // penalties from all matching sources stack
    }
    return worst;
};

// ── Parse troop note tags ─────────────────────────────────────────────────
TDarn.loadTroopPenalties = function() {
    TDarn._troopPenalties = [];
    if (!$gameTroop || !$gameTroop.troop()) return;
    var note = $gameTroop.troop().note || '';
    // Matches: <penalty: INT -1 if:technophobe>  or  <penalty: skill:Sword -2 if:clumsy>
    // The if:trait part is optional
    var re = /<penalty:\s*([\w:]+)\s+(-?\d+)(?:\s+if:([\w]+))?>/gi;
    var m;
    while ((m = re.exec(note)) !== null) {
        var entry = { stat: m[1].trim(), value: parseInt(m[2]), trait: (m[3] || '').trim().toLowerCase() || null };
        TDarn._troopPenalties.push(entry);
        console.log('[CONTEXT] Troop penalty: ' + entry.stat + ' ' + entry.value + (entry.trait ? ' (requires trait: ' + entry.trait + ')' : ' (all battlers)'));
    }
};

// ── Script call: set / clear event penalties ──────────────────────────────
TDarn.setContextPenalty = function(stat, value, trait) {
    var entry = { stat: stat.trim(), value: value, trait: trait ? trait.trim().toLowerCase() : null };
    // Replace any existing entry for same stat+trait
    TDarn._eventPenalties = TDarn._eventPenalties.filter(function(e) {
        return !(e.stat === entry.stat && e.trait === entry.trait);
    });
    TDarn._eventPenalties.push(entry);
    console.log('[CONTEXT] Event penalty set: ' + entry.stat + ' ' + value + (entry.trait ? ' if:' + entry.trait : ''));
};

TDarn.clearContextPenalty = function(stat, trait) {
    var s = stat.trim();
    var t = trait ? trait.trim().toLowerCase() : null;
    TDarn._eventPenalties = TDarn._eventPenalties.filter(function(e) {
        return !(e.stat === s && e.trait === t);
    });
};

TDarn.clearContext = function() {
    TDarn._eventPenalties = [];
    console.log('[CONTEXT] All event penalties cleared.');
};

// ── Penalty injection into combat rolls ───────────────────────────────────
TDarn.getAttackPenalty = function(subject, skillName) {
    var pen = TDarn.getPenaltyFor(subject, 'AGI');
    if (skillName) {
        var skillPen = TDarn.getPenaltyFor(subject, 'skill:' + skillName);
        pen += skillPen; // both AGI penalty and skill penalty stack
    }
    if (pen !== 0) console.log('[CONTEXT] Attack penalty for ' + subject.name() + ': ' + pen);
    return pen;
};

TDarn.getDefensePenalty = function(target) {
    var pen = TDarn.getPenaltyFor(target, 'AGI');
    if (pen !== 0) console.log('[CONTEXT] Defense penalty for ' + target.name() + ': ' + pen);
    return pen;
};

// ── In-event stat check ───────────────────────────────────────────────────
TDarn._doStatCheck = function(battler, stat, dc) {
    dc = dc || 10;
    var statKey = stat.toUpperCase();
    var statVal = 0;
    if (battler.tdarnBod) {
        var map = { BOD: battler.tdarnBod(), AGI: battler.tdarnAgi(), INT: battler.tdarnInt(),
                    POW: battler.tdarnPow ? battler.tdarnPow() : (battler.powerLevel ? battler.powerLevel() : 0),
                    WILL: battler.tdarnWill(), AWARE: battler.tdarnAware(), SOC: battler.tdarnSocial ? battler.tdarnSocial() : 0 };
        statVal = map[statKey] || 0;
    }
    var penalty = TDarn.getPenaltyFor(battler, statKey);
    var d20     = Math.floor(Math.random() * 20) + 1;
    var total   = d20 + statVal + penalty;
    var passed  = total >= dc;
    var penNote = penalty !== 0 ? ' + ' + penalty + ' penalty' : '';
    console.log('[CONTEXT] ' + battler.name() + ' ' + statKey + ' check: d20(' + d20 + ') + ' + statVal + penNote + ' = ' + total + ' vs DC ' + dc + ' → ' + (passed ? 'PASS' : 'FAIL'));
    $gameVariables.setValue(TDarn.LAST_CHECK_VAR, passed ? 1 : 0);
    $gameVariables.setValue(TDarn.LAST_ROLL_VAR,  total);
    return { roll: d20, total: total, passed: passed };
};

TDarn.statCheck = function(stat, actorId, dc) {
    var actor = $gameActors.actor(actorId);
    if (!actor) { console.warn('[CONTEXT] statCheck: actor ' + actorId + ' not found'); return { roll:0, total:0, passed:false }; }
    return TDarn._doStatCheck(actor, stat, dc);
};

TDarn.enemyStatCheck = function(stat, enemyIndex, dc) {
    var members = $gameTroop.members();
    var enemy   = members[enemyIndex];
    if (!enemy) { console.warn('[CONTEXT] enemyStatCheck: index ' + enemyIndex + ' not found'); return { roll:0, total:0, passed:false }; }
    return TDarn._doStatCheck(enemy, stat, dc);
};

// ── In-event skill check ──────────────────────────────────────────────────
TDarn.skillCheck = function(skillName, actorId, dc) {
    dc = dc || 10;
    var actor = $gameActors.actor(actorId);
    if (!actor) { console.warn('[CONTEXT] skillCheck: actor ' + actorId + ' not found'); return { roll:0, total:0, passed:false }; }
    var agiVal   = actor.tdarnAgi();
    var skillLvl = actor.tdarnSkillLevel(skillName);
    var agiPen   = TDarn.getPenaltyFor(actor, 'AGI');
    var skillPen = TDarn.getPenaltyFor(actor, 'skill:' + skillName);
    var penalty  = agiPen + skillPen; // both sources stack
    var d20      = Math.floor(Math.random() * 20) + 1;
    var total    = d20 + agiVal + skillLvl + penalty;
    var passed   = total >= dc;
    var penNote  = penalty !== 0 ? ' + ' + penalty + ' penalty' : '';
    console.log('[CONTEXT] ' + actor.name() + ' ' + skillName + ' check: d20(' + d20 + ') + ' + agiVal + ' AGI + ' + skillLvl + ' skill' + penNote + ' = ' + total + ' vs DC ' + dc + ' → ' + (passed ? 'PASS' : 'FAIL'));
    $gameVariables.setValue(TDarn.LAST_CHECK_VAR, passed ? 1 : 0);
    $gameVariables.setValue(TDarn.LAST_ROLL_VAR,  total);
    return { roll: d20, total: total, passed: passed };
};


// ── Core display function ─────────────────────────────────────────────────
//=============================================================================
// Dice Roll Display System
//
// Dice float ABOVE each combatant's sprite in world space.
// Each die is a Sprite added to the spriteset, positioned at the battler's
// _homeX / (_homeY - headroom). Modifier text floats beside it.
// Everything stays frozen on screen until the player presses OK/Z/click.
// BattleManager._waitingForDice = true blocks all battle processing.
//
// TDarn.showRoll(data):
//   data.attacker  — Game_Battler
//   data.defender  — Game_Battler (optional)
//   data.rolls     — array of { die:20|6, raw:N, mods:[{label,val}], total:N, label:'' }
//   data.result    — 'HIT' | 'CRIT' | 'PARRY' | 'MISS' | etc.
//   data.detail    — hit location / damage string
//
// Legacy string-array form still accepted.
//=============================================================================

// ── Public API ────────────────────────────────────────────────────────────

TDarn.showRoll = function(data) {
    var scene = SceneManager._scene;
    if (!scene) return;
    if (!scene._diceLayer) return;
    if (Array.isArray(data)) {
        scene._diceLayer.showLegacy(data);
    } else {
        scene._diceLayer.showRollData(data, false);
    }
};

// Like showRoll but adds dice without clearing existing ones (used for initiative)
TDarn.appendRoll = function(data) {
    var scene = SceneManager._scene;
    if (!scene || !scene._diceLayer) return;
    scene._diceLayer.showRollData(data, true);
};

TDarn.showRollAndWait = function(data, callback) {
    BattleManager._diceRollCallback = callback;
    TDarn.showRoll(data);
};

BattleManager._diceRollCallback = null;
BattleManager._waitingForDice   = false;

var _TDarn_BM_isBusy = BattleManager.isBusy;
BattleManager.isBusy = function() {
    if (this._waitingForDice) return true;
    return _TDarn_BM_isBusy.call(this);
};

// ── Sprite_DieAbove — one floating die above a battler ───────────────────
// Draws a polygon face with the roll number, plus modifier lines beside it.

function Sprite_DieAbove(battler, rollData) {
    this.initialize(battler, rollData);
}
Sprite_DieAbove.prototype = Object.create(Sprite.prototype);
Sprite_DieAbove.prototype.constructor = Sprite_DieAbove;

Sprite_DieAbove.DIE_SIZE   = 52;
Sprite_DieAbove.HEAD_ROOM  = 110;  // px above sprite home Y
Sprite_DieAbove.TEXT_W     = 120;
Sprite_DieAbove.TOTAL_W    = Sprite_DieAbove.DIE_SIZE + Sprite_DieAbove.TEXT_W + 8;
Sprite_DieAbove.LINE_H     = 16;

Sprite_DieAbove.prototype.initialize = function(battler, rollData) {
    var DS    = Sprite_DieAbove.DIE_SIZE;
    var TW    = Sprite_DieAbove.TEXT_W;
    var LH    = Sprite_DieAbove.LINE_H;
    var modLines = (rollData.mods || []).length;
    var bmpH   = LH + 2 + Math.max(DS, (modLines + 2) * LH) + 8; // name row + die/mods + total
    var bmpW   = Sprite_DieAbove.TOTAL_W;

    Sprite.prototype.initialize.call(this, new Bitmap(bmpW, bmpH));
    this._battler  = battler;
    this._rollData = rollData;
    this._drawFace();
    this._updatePosition();
};

Sprite_DieAbove.prototype._drawFace = function() {
    var bmp  = this.bitmap;
    var roll = this._rollData;
    var DS   = Sprite_DieAbove.DIE_SIZE;
    var TW   = Sprite_DieAbove.TEXT_W;
    var LH   = Sprite_DieAbove.LINE_H;
    var cx   = DS / 2, cy = DS / 2 + LH + 2, r = DS * 0.44;
    var W    = bmp.width, H = bmp.height;
    var ctx  = bmp.context;

    // ── Semi-transparent background ───────────────────────────────────────
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(0, 0, W, H, 6) : ctx.rect(0, 0, W, H);
    ctx.fill();
    bmp._dirty = true;

    // ── Battler name at top ───────────────────────────────────────────────
    var name = this._battler && this._battler.name ? this._battler.name() : '';
    bmp.fontSize  = 11;
    bmp.textColor = '#eeeeee';
    bmp.drawText(name, 0, 1, W, LH, 'center');

    // ── Die polygon ───────────────────────────────────────────────────────
    var n    = roll.die === 6 ? 4 : 10;
    var step = Math.PI * 2 / n;
    var off  = roll.die === 6 ? Math.PI / 4 : -Math.PI / 2;
    var pts  = [];
    for (var i = 0; i < n; i++) {
        pts.push([cx + r * Math.cos(off + step * i),
                  cy + r * Math.sin(off + step * i)]);
    }
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (var j = 1; j < pts.length; j++) ctx.lineTo(pts[j][0], pts[j][1]);
    ctx.closePath();

    var fillCol   = roll.die === 20 ? '#0d2a55' : '#3a1200';
    var strokeCol = roll.die === 20 ? '#5599ff' : '#ff8833';
    ctx.fillStyle   = fillCol;
    ctx.fill();
    ctx.strokeStyle = strokeCol;
    ctx.lineWidth   = 2.5;
    ctx.stroke();
    bmp._dirty = true;

    // ── Raw number on die face ────────────────────────────────────────────
    bmp.fontSize  = Math.floor(DS * 0.40);
    bmp.textColor = '#ffffff';
    bmp.drawText(String(roll.raw), 0, (LH + 2) + DS * 0.22, DS, DS * 0.5, 'center');

    // ── Label above text column ───────────────────────────────────────────
    var tx = DS + 6;
    var ty = LH + 2;
    bmp.fontSize  = 12;
    bmp.textColor = '#cccccc';
    bmp.drawText(roll.label || '', tx, ty, TW, LH, 'left');

    // ── Modifier lines ────────────────────────────────────────────────────
    var my = ty + LH + 2;
    (roll.mods || []).forEach(function(mod) {
        bmp.fontSize  = 12;
        bmp.textColor = mod.val >= 0 ? '#88ff88' : '#ff7777';
        var sign = mod.val >= 0 ? '+' : '';
        bmp.drawText(sign + mod.val + ' ' + mod.label, tx, my, TW, LH, 'left');
        my += LH;
    });

    // ── Total ─────────────────────────────────────────────────────────────
    bmp.fontSize  = 16;
    bmp.textColor = '#ffd84a';
    bmp.drawText('= ' + (roll.total !== undefined ? roll.total : roll.raw), tx, my, TW, LH + 4, 'left');
};

Sprite_DieAbove.prototype._updatePosition = function() {
    var sp = TDarn.getBattlerSprite(this._battler);
    if (sp) {
        this.x = (sp._homeX || sp.x) - Sprite_DieAbove.TOTAL_W / 2;
        this.y = (sp._homeY || sp.y) - Sprite_DieAbove.HEAD_ROOM;
    }
};

Sprite_DieAbove.prototype.update = function() {
    Sprite.prototype.update.call(this);
    this._updatePosition();
};

// ── TDarn_DiceLayer — manages all floating dice for one roll event ─────────

function TDarn_DiceLayer() {
    this._sprites   = [];
    this._waiting   = false;
    this._legacyBmp = null;
    this._legacySp  = null;
}

TDarn_DiceLayer.RESULT_COLORS = {
    'HIT': '#ff6644', 'CRIT': '#ff2222', 'PARRY': '#4488ff',
    'MISS': '#888888', 'REVIVED': '#88ff88'
};

TDarn_DiceLayer.prototype.showRollData = function(data, append) {
    if (!append) this._clear();
    this._waiting    = true;
    this._holdFrames = 8;
    BattleManager._waitingForDice = true;
    // Immediately hide the actor command window so it can't be interacted with
    var scene = SceneManager._scene;
    if (scene && scene._actorCommandWindow) {
        scene._actorCommandWindow.deactivate();
        scene._actorCommandWindow.hide();
    }
    if (!scene || !scene._spriteset) return;

    // One die per roll entry; assign to attacker or defender by index
    var battlers = [];
    if (data.attacker) battlers.push(data.attacker);
    if (data.defender) battlers.push(data.defender);

    data.rolls.forEach(function(roll, i) {
        var battler = battlers[i] || battlers[0];
        if (!battler) return;
        var die = new Sprite_DieAbove(battler, roll);
        scene.addChild(die);
        this._sprites.push(die);
    }, this);

    // Result label only for non-empty results
    if (data.result) {
        this._showResultLabel(data.result, data.detail);
    }
};

TDarn_DiceLayer.prototype.showLegacy = function(lines) {
    this._clear();
    this._waiting = true;
    BattleManager._waitingForDice = true;
    var scene = SceneManager._scene;
    if (!scene || !scene._spriteset) return;
    var W = 360, LH = 20;
    var bmp = new Bitmap(W, lines.length * LH + 8);
    lines.forEach(function(line, i) {
        bmp.fontSize  = 15;
        bmp.textColor = i === 0 ? '#ffd84a' : '#ffffff';
        bmp.drawText(line, 0, i * LH + 4, W, LH, 'left');
    });
    var sp = new Sprite(bmp);
    sp.x   = Math.floor((Graphics.width - W) / 2);
    sp.y   = 20;
    scene.addChild(sp);
    this._sprites.push(sp);
};

TDarn_DiceLayer.prototype._showResultLabel = function(result, subtitle) {
    // No-op: result shown on die sprites
};

TDarn_DiceLayer.prototype.update = function() {
    if (!this._waiting) return;
    if (this._holdFrames > 0) { this._holdFrames--; return; }
    if (Input.isTriggered('ok') || Input.isTriggered('cancel') || TouchInput.isTriggered()) {
        this._dismiss();
    }
};

TDarn_DiceLayer.prototype._dismiss = function() {
    this._waiting = false;
    BattleManager._waitingForDice = false;
    this._clear();
    if (BattleManager._diceRollCallback) {
        var cb = BattleManager._diceRollCallback;
        BattleManager._diceRollCallback = null;
        cb();
    }
};

TDarn_DiceLayer.prototype._clear = function() {
    var scene = SceneManager._scene;
    this._sprites.forEach(function(sp) {
        if (sp.parent) sp.parent.removeChild(sp);
        if (sp.bitmap) { try { sp.bitmap.destroy(); } catch(e) {} }
    });
    this._sprites   = [];
    this._legacySp  = null;
    this._legacyBmp = null;
};

// ── Helpers ───────────────────────────────────────────────────────────────

TDarn.getBattlerSprite = function(battler) {
    var scene = SceneManager._scene;
    if (!scene || !scene._spriteset) return null;
    if (battler.isActor()) {
        var actors = scene._spriteset._actorSprites || [];
        for (var i = 0; i < actors.length; i++) {
            if ((actors[i]._actor || actors[i]._battler) === battler) return actors[i];
        }
    } else {
        var enemies = scene._spriteset._enemySprites || [];
        for (var i = 0; i < enemies.length; i++) {
            if ((enemies[i]._enemy || enemies[i]._battler) === battler) return enemies[i];
        }
    }
    return null;
};

// Inject window creation into Scene_Battle
// (dice window created inside main createAllWindows below)

//=============================================================================
// BattleManager Initiative Override
//=============================================================================

var _TDarn_makingActionOrders = false;

BattleManager.makeActionOrders = function() {
    if (_TDarn_makingActionOrders) return;
    _TDarn_makingActionOrders = true;

    var combatants = [];
    $gameParty.aliveMembers().forEach(function(m) { combatants.push(m); });
    $gameTroop.aliveMembers().forEach(function(m) { combatants.push(m); });

    if (combatants.length > 0) {
        combatants.forEach(function(battler) {
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

// _defaultBattleColumn: set in formation menu, restored at start of each battle.
// _battleColumn: live position during combat, reset to default each battle start.

Game_Actor.prototype.defaultBattleColumn = function() {
    if (this._defaultBattleColumn !== undefined) return this._defaultBattleColumn;
    var members = $gameParty ? $gameParty.members() : [];
    return members.indexOf(this) >= 4 ? 0 : 1;
};

Game_Actor.prototype.setBattlePosition = function(column) {
    this._battleColumn = Math.max(0, Math.min(3, column));
    if (SceneManager._scene && SceneManager._scene._spriteset) {
        SceneManager._scene._spriteset.updateActorPositions();
    }
};

Game_Actor.prototype.battlePosition = function() {
    var base = this._battleColumn !== undefined ? this._battleColumn : this.defaultBattleColumn();
    // During input phase, _moveModifier reflects announced intent (+1 fwd, -1 back)
    // This affects range calculations so other actors can plan accordingly
    var mod = this._moveModifier || 0;
    return Math.max(0, Math.min(3, base + mod));
};

Game_Actor.prototype.resetBattleColumn = function() {
    this._battleColumn = this.defaultBattleColumn();
};

Game_Enemy.prototype.battlePosition = function() {
    // Live column takes precedence; falls back to note tag default.
    var base;
    if (this._battleColumn !== undefined) {
        base = this._battleColumn;
    } else {
        var enemy = this.enemy();
        base = (enemy && enemy.meta && enemy.meta.column)
            ? parseInt(enemy.meta.column) || 1
            : 1;
    }
    // _moveModifier mirrors actor system: +1 = announced forward, -1 = back
    var mod = this._moveModifier || 0;
    return Math.max(0, Math.min(3, base + mod));
};

Game_Enemy.prototype.setBattlePosition = function(col) {
    this._battleColumn = Math.max(0, Math.min(3, col));
};

Game_Enemy.prototype.moveForward = function() {
    var cur = this.battlePosition();
    if (cur < 3) { this.setBattlePosition(cur + 1); return true; }
    return false;
};

Game_Enemy.prototype.moveBackward = function() {
    var cur = this.battlePosition();
    if (cur > 0) { this.setBattlePosition(cur - 1); return true; }
    return false;
};

// Reset live column to note-tag default at battle start
Game_Enemy.prototype.resetBattleColumn = function() {
    var enemy = this.enemy();
    this._battleColumn = (enemy && enemy.meta && enemy.meta.column)
        ? parseInt(enemy.meta.column) || 1
        : 1;
    this._aiMovedBackHP  = false;  // HP-retreat flag
    this._aiMovedFwdCrit = false;  // crit-advance flag
};


//=============================================================================
// Enemy AI Movement System
//
// Enemies can be given movement behaviour via note tags in their Notes box.
// Movement REPLACES the enemy's action for that turn (same as players).
//
// ── Note tag syntax ──────────────────────────────────────────────────────
//   <aiMove: back if hp < 50>      retreat when HP drops below 50%
//   <aiMove: forward if crit>      advance after dealing a critical hit
//   <aiMove: forward if behind>    advance when behind the closest actor
//   Multiple tags allowed — first matching condition wins each turn.
//
// ── Column passing rule ───────────────────────────────────────────────────
//   Enemies cannot advance past the closest living actor's column.
//
// ── HP threshold ─────────────────────────────────────────────────────────
//   Retreats when HP < threshold%, advances again when healed above it.
//=============================================================================

TDarn.parseEnemyAI = function(enemy) {
    if (!enemy || !enemy.enemy()) return [];
    var note = enemy.enemy().note || '';
    var rules = [];
    var re = /<aiMove:\s*(forward|back)\s+if\s+(target\s+hp\s*<\s*\d+|hp\s*<\s*\d+|crit|behind|out\s+of\s+range)>/gi;
    var m;
    while ((m = re.exec(note)) !== null) {
        var dir  = m[1].toLowerCase();
        var cond = m[2].toLowerCase().replace(/\s/g, '');
        var rule = { dir: dir, cond: cond };
        if (cond.indexOf('targethp<') === 0) {
            rule.type = 'target_hp';
            rule.threshold = parseInt(cond.replace('targethp<', ''));
        } else if (cond.indexOf('hp<') === 0) {
            rule.type = 'hp';
            rule.threshold = parseInt(cond.replace('hp<', ''));
        } else if (cond === 'crit') {
            rule.type = 'crit';
        } else if (cond === 'behind') {
            rule.type = 'behind';
        } else if (cond === 'outofrange') {
            rule.type = 'outofrange';
        }
        rules.push(rule);
    }
    return rules;
};

// Returns the column of the most advanced living actor.
TDarn.closestActorColumn = function() {
    var members = $gameParty.aliveMembers();
    if (!members.length) return 0;
    var maxCol = 0;
    members.forEach(function(a) {
        var col = a.battlePosition ? a.battlePosition() : 0;
        if (col > maxCol) maxCol = col;
    });
    return maxCol;
};

// Enemies cannot advance past the closest actor's column.
TDarn.enemyCanAdvance = function(enemy) {
    var cur = enemy.battlePosition();
    if (cur >= 3) return false;
    return cur < TDarn.closestActorColumn();
};

// Evaluate movement intent for this enemy. Returns 'forward', 'back', or null.
TDarn.evaluateEnemyMove = function(enemy) {
    var rules = TDarn.parseEnemyAI(enemy);
    if (!rules.length) return null;
    var hpPct = enemy.mhp > 0 ? (enemy.hp / enemy.mhp) * 100 : 100;

    for (var i = 0; i < rules.length; i++) {
        var r = rules[i];

        if (r.type === 'hp') {
            var below = hpPct < r.threshold;
            if (below && !enemy._aiMovedBackHP) {
                enemy._aiMovedBackHP = true;
                if (r.dir === 'back') return 'back';
            } else if (!below && enemy._aiMovedBackHP) {
                enemy._aiMovedBackHP = false;
                if (r.dir === 'back') return 'forward'; // recover position
            }
        }

        if (r.type === 'crit') {
            if (BattleManager._lastCritEnemy === enemy && r.dir === 'forward' && TDarn.enemyCanAdvance(enemy)) {
                return 'forward';
            }
        }

        if (r.type === 'behind') {
            if (enemy.battlePosition() < TDarn.closestActorColumn() && r.dir === 'forward' && TDarn.enemyCanAdvance(enemy)) {
                return 'forward';
            }
        }

        if (r.type === 'outofrange') {
            var hasTarget = $gameParty.aliveMembers().some(function(a) {
                return isInValidRange(enemy, a);
            });
            if (!hasTarget) {
                if (r.dir === 'forward' && TDarn.enemyCanAdvance(enemy)) return 'forward';
                if (r.dir === 'back' && enemy.battlePosition() > 0) return 'back';
            }
        }

        if (r.type === 'target_hp') {
            // Move toward any living actor below the HP threshold.
            var weakActor = null;
            $gameParty.aliveMembers().forEach(function(a) {
                var pct = a.mhp > 0 ? (a.hp / a.mhp) * 100 : 100;
                if (pct < r.threshold) weakActor = a;
            });
            if (weakActor && r.dir === 'forward' && TDarn.enemyCanAdvance(enemy)) {
                console.log('[AI] ' + enemy.name() + ' targeting wounded actor: ' + weakActor.name() + ' (' + Math.floor(weakActor.hp / weakActor.mhp * 100) + '% HP)');
                return 'forward';
            }
        }
    }
    return null;
};

// Execute AI movement. Announces intent (modifier), executes on their turn.
TDarn.processEnemyAIMove = function(enemy) {
    var dir = TDarn.evaluateEnemyMove(enemy);
    if (!dir) return false;
    // Check column cap before committing
    if (dir === 'forward' && !TDarn.enemyCanAdvance(enemy)) return false;
    if (dir === 'back'    && enemy.battlePosition() <= 0)   return false;
    // Store pending move — actual column change happens in processTurn on their turn
    enemy._pendingMoveDir  = dir;
    enemy._moveModifier    = dir === 'forward' ? 1 : -1;
    console.log('[AI] ' + enemy.name() + ' announces move ' + dir + ' (modifier ' + enemy._moveModifier + ')');
    $gameMessage.add(enemy.name() + ' moves ' + dir + '!');
    var spriteset = SceneManager._scene ? SceneManager._scene._spriteset : null;
    if (spriteset && spriteset.updateEnemyPositions) spriteset.updateEnemyPositions();
    return true;
};

function getRangeDistance(attacker, target) {
    // Linear distance across the 7-position battlefield.
    // Actor cols 0-3 mirror enemy cols 0-3. Actor col 3 faces enemy col 3.
    // Distance = steps between them: (3 - actorCol) + (3 - enemyCol), range 0-6.
    if (!attacker.battlePosition || !target.battlePosition) return 2;
    if (attacker.isActor() === target.isActor()) return 0;
    var actorCol = attacker.isActor() ? attacker.battlePosition() : target.battlePosition();
    var enemyCol = attacker.isActor() ? target.battlePosition()   : attacker.battlePosition();
    return (3 - actorCol) + (3 - enemyCol);
}

function getRangeModifier(distance) {
    // distance 0 = Point Blank (+4), 1 = Short (+2), 2 = Medium (0),
    // 3 = Long (-2), 4 = Extreme (-4).
    // Further away = harder to hit.
    var mods = [4, 2, 0, -2, -4];
    return mods[distance] !== undefined ? mods[distance] : -4;
}

//=============================================================================
// Visual Positioning for Columns
//=============================================================================

// Hook createActors to immediately snap all actors to their column positions.
// Without this, MV places actors with its own defaults and the lerp starts
// from the wrong position.
const _Spriteset_Battle_createActors = Spriteset_Battle.prototype.createActors;
Spriteset_Battle.prototype.createActors = function() {
    _Spriteset_Battle_createActors.call(this);
    this.updateActorPositions();
};

// updateActorPositions replaced by column-aware version above


//=============================================================================
// Battlefield Column Layout
//
// The battlefield is divided into 4 columns, mirrored for actors vs enemies.
// Column 0 = Back, 1 = Mid-Back, 2 = Mid-Front, 3 = Vanguard (front)
//
// Actor  col 0 → far right  (x≈760)    Enemy col 0 → far left  (x≈56)
// Actor  col 1 → mid-right  (x≈630)    Enemy col 1 → mid-left  (x≈186)
// Actor  col 2 → mid-left   (x≈500)    Enemy col 2 → mid-right (x≈316)
// Actor  col 3 → vanguard   (x≈390)    Enemy col 3 → vanguard  (x≈426)
//
// Distance formula: |actorCol - (3 - enemyCol)| → range modifier applies.
// (Enemy col 0 = "their back row" = furthest from actor col 3.)
//=============================================================================

// ── Column X positions ────────────────────────────────────────────────────
TDarn.COLUMNS = 4;
TDarn.COL_LABELS = ['Back', 'Mid', 'Front', 'Van'];

// X centre for each actor column (right side of field, col 3 closest to centre)
TDarn.actorColX = function(col) {
    // col 0=far right, col 3=near centre
    // Van (col 3) pulled right to 440 so actors don't overlap with enemy van (360)
    var positions = [790, 650, 530, 440];
    return positions[col] || positions[1];
};

// X centre for each enemy column (left side of field, col 3 closest to centre)
TDarn.enemyColX = function(col) {
    // col 0=far left, col 3=near centre (mirrors actors)
    // Van (col 3) pulled left to 376 so enemies don't overlap with actor van (440)
    var positions = [26, 166, 286, 376];
    return positions[col] || positions[1];
};

// Y positions for the front 4 actors (indices 0-3), spread vertically.
// Actors 4-5 share Y with actors 1-2 (center pair) and sit behind them.
// Fixed Y slots for actors within a column. Up to 4 per column.
TDarn.ACTOR_Y_SLOTS = [250, 305, 360, 415];

TDarn.actorRowY = function(slotIndex) {
    return TDarn.ACTOR_Y_SLOTS[Math.max(0, Math.min(3, slotIndex))];
};

// Build column map: { col: [actors in party order] } for positioning and cap checks.
TDarn.buildColumnMap = function(members) {
    var map = {0: [], 1: [], 2: [], 3: []};
    members.forEach(function(actor) {
        var col = actor.battlePosition ? actor.battlePosition() : 1;
        col = Math.max(0, Math.min(3, col));
        map[col].push(actor);
    });
    return map;
};

// ── Battlefield Grid Background ───────────────────────────────────────────

Spriteset_Battle.prototype.createBattlefieldGrid = function() {
    var w = Graphics.width;
    var h = Graphics.height;
    var bmp = new Bitmap(w, h);

    // Zone bands — 4 pairs (actor side + enemy side) with subtle alternating fill
    var zoneColors = [
        'rgba(20,20,60,0.18)',   // col 0 back — dark blue
        'rgba(20,60,20,0.13)',   // col 1 mid-back — dark green
        'rgba(60,40,10,0.13)',   // col 2 mid-front — dark amber
        'rgba(60,10,10,0.18)'    // col 3 vanguard — dark red
    ];

    var actorXs = [790, 650, 530, 440];
    var enemyXs = [26, 166, 286, 376];
    var zoneHalfW = 55; // half-width of each column zone highlight

    for (var col = 0; col < 4; col++) {
        var color = zoneColors[col];

        // Actor zone band
        bmp.fillRect(actorXs[col] - zoneHalfW, 0, zoneHalfW * 2, h, color);
        // Enemy zone band  
        bmp.fillRect(enemyXs[col] - zoneHalfW, 0, zoneHalfW * 2, h, color);
    }

    // Vertical divider down the centre
    bmp.fillRect(408, 80, 2, h - 120, 'rgba(255,255,255,0.12)');

    // Column labels — actor side (bottom of screen)
    var labelY = 160;
    bmp.fontSize = 13;
    for (var c = 0; c < 4; c++) {
        bmp.textColor = 'rgba(200,210,255,0.75)';
        bmp.drawText(TDarn.COL_LABELS[c], actorXs[c] - 30, labelY, 60, 20, 'center');
    }
    // Enemy side labels (mirrored: col 0 on their far left = "their back")
    var enemyLabels = ['Back', 'Mid', 'Front', 'Van'];
    for (var c = 0; c < 4; c++) {
        bmp.textColor = 'rgba(255,180,180,0.65)';
        bmp.drawText(enemyLabels[c], enemyXs[c] - 30, labelY, 60, 20, 'center');
    }

    // Horizontal ground line
    bmp.fillRect(0, h - 78, w, 1, 'rgba(255,255,255,0.10)');

    var sprite = new Sprite(bmp);
    sprite.z = 0;
    this._battlefieldGrid = sprite;
    this._battleField.addChild(sprite); // add behind battler sprites
};

// Hook into Spriteset_Battle.createLowerLayer to add grid after battleback
const _Spriteset_Battle_createLowerLayer = Spriteset_Battle.prototype.createLowerLayer;
Spriteset_Battle.prototype.createLowerLayer = function() {
    _Spriteset_Battle_createLowerLayer.call(this);
    this.createBattlefieldGrid();
};

// ── Actor positioning ─────────────────────────────────────────────────────

// Override setActorHome — this is what MV calls (via setBattler) to set the
// resting position for each Sprite_Actor. Overriding here means our column
// positions win at the point of creation, before updatePosition() ever runs.
var _Sprite_Actor_setActorHome = Sprite_Actor.prototype.setActorHome;
Sprite_Actor.prototype.setActorHome = function(index) {
    var members = $gameParty.battleMembers();
    var actor   = members[index];
    if (actor && actor.battlePosition) {
        var col     = Math.max(0, Math.min(3, actor.battlePosition()));
        var colMap  = TDarn.buildColumnMap(members);
        var colList = colMap[col] || [];
        var slot    = colList.indexOf(actor);
        if (slot < 0) slot = 0;
        var offset  = Math.floor((4 - colList.length) / 2);
        this.setHome(TDarn.actorColX(col), TDarn.actorRowY(offset + slot));
    } else {
        _Sprite_Actor_setActorHome.call(this, index);
    }
};

Spriteset_Battle.prototype.updateActorPositions = function() {
    if (!this._actorSprites) return;
    var members = $gameParty.battleMembers();
    var colMap  = TDarn.buildColumnMap(members);

    for (var i = 0; i < this._actorSprites.length; i++) {
        var sprite = this._actorSprites[i];
        if (!sprite) continue;
        var actor = sprite._actor || sprite._battler;
        if (!actor) actor = members[i];
        if (!actor) continue;

        var col     = actor.battlePosition ? actor.battlePosition() : 1;
        col = Math.max(0, Math.min(3, col));
        var colList = colMap[col] || [];
        var slot    = colList.indexOf(actor);
        if (slot < 0) slot = 0;
        var offset  = Math.floor((4 - colList.length) / 2);

        var tx = TDarn.actorColX(col);
        var ty = TDarn.actorRowY(offset + slot);

        sprite.opacity = 255;
        sprite.scale.x = 1.0;
        sprite.scale.y = 1.0;
        sprite.setHome(tx, ty);
        sprite._tdarnTargetX = tx;
        sprite._tdarnTargetY = ty;
    }
};

// Lerp _homeX/_homeY toward target each frame — since Sprite_Actor.updatePosition()
// computes x/y FROM _homeX/_homeY, lerping the home values is the correct approach.
const _Spriteset_Battle_update_pos = Spriteset_Battle.prototype.update;
Spriteset_Battle.prototype.update = function() {
    _Spriteset_Battle_update_pos.call(this);
    if (!this._actorSprites) return;
    var LERP = 0.18;
    for (var i = 0; i < this._actorSprites.length; i++) {
        var sp = this._actorSprites[i];
        if (sp && sp._tdarnTargetX !== undefined) {
            var dx = sp._tdarnTargetX - sp._homeX;
            var dy = sp._tdarnTargetY - sp._homeY;
            if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
                sp._homeX += dx * LERP;
                sp._homeY += dy * LERP;
            } else {
                sp._homeX = sp._tdarnTargetX;
                sp._homeY = sp._tdarnTargetY;
            }
        }
    }
};

// ── Enemy positioning ──────────────────────────────────────────────────────

// Override Spriteset_Battle to reposition enemy sprites after creation
const _Spriteset_Battle_createEnemies = Spriteset_Battle.prototype.createEnemies;
Spriteset_Battle.prototype.createEnemies = function() {
    _Spriteset_Battle_createEnemies.call(this);
    this.updateEnemyPositions();
};

// Build column map for enemies (mirrors actor buildColumnMap)
TDarn.buildEnemyColumnMap = function(members) {
    var map = {0: [], 1: [], 2: [], 3: []};
    members.forEach(function(enemy) {
        var col = enemy.battlePosition ? enemy.battlePosition() : 2;
        col = Math.max(0, Math.min(3, col));
        map[col].push(enemy);
    });
    return map;
};

Spriteset_Battle.prototype.updateEnemyPositions = function() {
    if (!this._enemySprites) return;
    var allMembers = $gameTroop.members();
    var colMap = TDarn.buildEnemyColumnMap(allMembers);

    for (var i = 0; i < this._enemySprites.length; i++) {
        var sprite = this._enemySprites[i];
        if (!sprite) continue;
        var enemy = sprite._enemy || sprite._battler;
        if (!enemy) continue;

        var col     = enemy.battlePosition ? enemy.battlePosition() : 2;
        col = Math.max(0, Math.min(3, col));
        var colList = colMap[col] || [];
        var slot    = colList.indexOf(enemy);
        if (slot < 0) slot = 0;
        var offset  = Math.floor((4 - Math.min(colList.length, 4)) / 2);

        var cx = TDarn.enemyColX(col);
        var cy = TDarn.actorRowY(offset + slot);  // same Y grid as actors

        sprite._homeX = cx;
        sprite._homeY = cy;
        sprite.x = cx;
        sprite.y = cy;
    }
};

//=============================================================================
// Pre-Battle Formation Menu
//
// Accessible from Scene_Menu via a "Formation" command.
// Shows party members as a list; arrow keys move them between columns 0-3.
// Changes persist as _battleColumn on each Game_Actor.
//=============================================================================

// ── Add Formation command to main menu ───────────────────────────────────

const _Window_MenuCommand_addOriginalCommands = Window_MenuCommand.prototype.addOriginalCommands;
Window_MenuCommand.prototype.addOriginalCommands = function() {
    _Window_MenuCommand_addOriginalCommands.call(this);
    // Use symbol 'battleFormation' (not 'formation') to avoid clashing with
    // Yanfly's native Formation (party reorder) command which uses 'formation'.
    this.addCommand('Battle Pos.', 'battleFormation', true);
};

const _Scene_Menu_createCommandWindow_form = Scene_Menu.prototype.createCommandWindow;
Scene_Menu.prototype.createCommandWindow = function() {
    _Scene_Menu_createCommandWindow_form.call(this);
    this._commandWindow.setHandler('battleFormation', this.commandFormation.bind(this));
};

Scene_Menu.prototype.commandFormation = function() {
    SceneManager.push(Scene_Formation);
};

// ── Scene_Formation ───────────────────────────────────────────────────────

function Scene_Formation() {
    this.initialize.apply(this, arguments);
}

Scene_Formation.prototype = Object.create(Scene_MenuBase.prototype);
Scene_Formation.prototype.constructor = Scene_Formation;

Scene_Formation.prototype.initialize = function() {
    Scene_MenuBase.prototype.initialize.call(this);
};

Scene_Formation.prototype.create = function() {
    Scene_MenuBase.prototype.create.call(this);
    this.createHelpWindow();
    this.createFormationWindow();
};

Scene_Formation.prototype.createHelpWindow = function() {
    this._helpWindow = new Window_Help(2);
    this._helpWindow.setText("Set each character's starting battle column. ← → to change, Z/Enter to confirm.");
    this.addWindow(this._helpWindow);
};

Scene_Formation.prototype.createFormationWindow = function() {
    var wy = this._helpWindow.height;
    this._formationWindow = new Window_FormationSelect(0, wy);
    this._formationWindow.setHandler('ok', this.onFormationOk.bind(this));
    this._formationWindow.setHandler('cancel', this.popScene.bind(this));
    this.addWindow(this._formationWindow);
};

Scene_Formation.prototype.onFormationOk = function() {
    this._formationWindow.activate();
};

// ── Window_FormationSelect ────────────────────────────────────────────────

function Window_FormationSelect() {
    this.initialize.apply(this, arguments);
}

Window_FormationSelect.prototype = Object.create(Window_Selectable.prototype);
Window_FormationSelect.prototype.constructor = Window_FormationSelect;

Window_FormationSelect.prototype.initialize = function(x, y) {
    var w = Graphics.boxWidth;
    var h = Graphics.boxHeight - y;
    Window_Selectable.prototype.initialize.call(this, x, y, w, h);
    this.refresh();
    this.select(0);
    this.activate();
};

Window_FormationSelect.prototype.maxItems = function() {
    return $gameParty.members().length;
};

Window_FormationSelect.prototype.itemHeight = function() {
    return 72;
};

Window_FormationSelect.prototype.drawItem = function(index) {
    var actor = $gameParty.members()[index];
    if (!actor) return;

    var rect = this.itemRect(index);
    var col = actor.defaultBattleColumn ? actor.defaultBattleColumn() : 1;

    // Draw actor face
    this.drawFace(actor.faceName(), actor.faceIndex(), rect.x + 4, rect.y + 4, 64, 64);

    // Name
    this.contents.fontSize = 18;
    this.drawText(actor.name(), rect.x + 80, rect.y + 8, 160, 'left');

    // Column selector: [◄] Back [■□□□] Van [►]
    var colNames = ['Back', 'Mid-Back', 'Mid-Front', 'Vanguard'];
    var barX = rect.x + 250;
    var barY = rect.y + 22;

    // Draw 4 pip boxes
    for (var c = 0; c < 4; c++) {
        var px = barX + c * 40;
        if (c === col) {
            // Active column: filled box with label
            this.contents.fillRect(px, barY, 34, 28, 'rgba(255,200,50,0.85)');
            this.contents.textColor = '#000000';
        } else {
            this.contents.fillRect(px, barY, 34, 28, 'rgba(80,80,100,0.6)');
            this.contents.textColor = 'rgba(180,180,200,0.8)';
        }
        this.contents.fontSize = 11;
        this.drawText(TDarn.COL_LABELS[c], px, barY + 7, 34, 'center');
    }

    // ◄ ► arrows
    this.contents.textColor = 'rgba(255,255,180,0.9)';
    this.contents.fontSize = 20;
    this.drawText('◄', barX - 28, barY + 2, 24, 'center');
    this.drawText('►', barX + 170, barY + 2, 24, 'center');

    // Column description
    this.contents.fontSize = 13;
    this.contents.textColor = 'rgba(200,220,255,0.75)';
    this.drawText(colNames[col], rect.x + 80, rect.y + 44, 200, 'left');
};

// Handle left/right to change column
Window_FormationSelect.prototype.processCursorMove = function() {
    if (this.isCursorMovable()) {
        var index = this.index();
        if (Input.isRepeated('right')) {
            this.changeColumn(index, 1);
        } else if (Input.isRepeated('left')) {
            this.changeColumn(index, -1);
        }
    }
    Window_Selectable.prototype.processCursorMove.call(this);
};

Window_FormationSelect.prototype.changeColumn = function(index, delta) {
    var actor = $gameParty.members()[index];
    if (!actor) return;
    var cur  = actor.defaultBattleColumn ? actor.defaultBattleColumn() : 1;
    var next = Math.max(0, Math.min(3, cur + delta));
    if (next === cur) return;
    // Enforce 4-per-column cap
    var members  = $gameParty.members();
    var colCount = members.filter(function(a, i) {
        if (i === index) return false;
        return (a.defaultBattleColumn ? a.defaultBattleColumn() : 1) === next;
    }).length;
    if (colCount >= 4) { SoundManager.playBuzzer(); return; }
    actor._defaultBattleColumn = next;
    SoundManager.playCursor();
    this.redrawItem(index);
};

//=============================================================================
// Formation Commands
//=============================================================================

Game_Actor.prototype.moveForward = function() {
    var cur  = this.battlePosition();
    if (cur >= 3) return false;
    var dest    = cur + 1;
    var members = $gameParty.battleMembers();
    // Van (col 3) allows 4 actors + 4 enemies simultaneously (shared melee zone).
    // All other columns cap at 4 actors only.
    var count = members.filter(function(a) {
        return a !== this && (a.battlePosition ? a.battlePosition() : 1) === dest;
    }, this).length;
    if (count >= 4) { $gameMessage.add('Column is full!'); return false; }
    this.setBattlePosition(dest);
    return true;
};

Game_Actor.prototype.moveBackward = function() {
    var currentPos = this.battlePosition();
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
    this.deactivate();
    this.select(-1);
};

Window_MoveCommand.prototype.windowWidth = function() {
    return 200;
};

Window_MoveCommand.prototype.makeCommandList = function() {
    var canForward = !this._actor || this._actor.battlePosition() < 3;
    var canBack    = !this._actor || this._actor.battlePosition() > 0;
    this.addCommand('Forward', 'forward', canForward);
    this.addCommand('Back',    'back',    canBack);
    this.addCommand('Cancel',  'cancel',  true);
};

Window_MoveCommand.prototype.setActor = function(actor) {
    this._actor = actor;
    this._moveChoice = null;
    this.refresh();
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

// Battle status window: taller by 30px, larger text, TP hidden
Window_BattleStatus.prototype.lineHeight = function() { return 27; };
Window_BattleStatus.prototype.standardFontSize = function() { return 17; };

// Hide TP — draw only HP and MP gauges
Window_BattleStatus.prototype.drawGaugeAreaSmall = function(rect, actor) {
    var gw = 201;
    var gaugeH = 6;
    var x = rect.x + rect.width - gw - 4;
    var y = rect.y + rect.height - gaugeH * 2 - 2;
    this.drawActorHp(actor, x, rect.y + 2, gw);
    this.drawActorMp(actor, x, rect.y + this.lineHeight() + 2, gw);
};

// Match actor command window height to status window height
Window_ActorCommand.prototype.windowHeight = function() {
    return this._statusWindow ? this._statusWindow.height
        : Window_Command.prototype.windowHeight.call(this);
};

Window_ActorCommand.prototype.lineHeight = function() { return 36; };
Window_ActorCommand.prototype.standardFontSize = function() { return 22; };

Window_ActorCommand.prototype.makeCommandList = function() {
    _Window_ActorCommand_makeCommandList.call(this);
    // Grey out Attack if no enemies are in range for this actor's weapon
    if (this._actor) {
        var attackCmd = this._list.find(function(cmd) { return cmd.symbol === 'attack'; });
        if (attackCmd) {
            attackCmd.enabled = TDarn.hasValidTarget(this._actor);
        }
    }
    if (!this._list.some(function(cmd) { return cmd.symbol === 'move'; })) {
        this.addCommand('Move', 'move', true);
    }
    // Show "Lwr. Shield" only when this actor has an active shield
    if (this._actor && this._actor.hasActiveShield && this._actor.hasActiveShield()) {
        this.addCommand('Lwr. Shield', 'lowerShield', true);
    }
};

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
    
    this._spellLevelWindow = new Window_SpellLevel(0, 0);
    this._spellLevelWindow.x = Graphics.boxWidth - this._spellLevelWindow.width;
    this._spellLevelWindow.y = this._statusWindow.y - this._spellLevelWindow.height;
    this.addWindow(this._spellLevelWindow);
    this._spellLevelWindow.hide();
    
    for (let i = 1; i <= 40; i++) {
        this._spellLevelWindow.setHandler('level' + i, this.onSpellLevelSelect.bind(this, i));
    }
    this._spellLevelWindow.setHandler('cancel', this.onSpellLevelCancel.bind(this));

    // Dice layer — floating sprites above battlers, updated each frame
    this._diceLayer = new TDarn_DiceLayer();
};

Scene_Battle.prototype.isAnyInputWindowActive = function() {
    return (this._partyCommandWindow.active ||
            this._actorCommandWindow.active ||
            this._skillWindow.active ||
            this._itemWindow.active ||
            this._actorWindow.active ||
            this._enemyWindow.active ||
            (this._moveWindow && this._moveWindow.active) ||
            (this._spellLevelWindow && this._spellLevelWindow.active));
};

Scene_Battle.prototype.createActorCommandWindow = function() {
    _Scene_Battle_createActorCommandWindow.call(this);
    this._actorCommandWindow.setHandler('move', this.onMove.bind(this));
    this._actorCommandWindow.setHandler('lowerShield', this.onLowerShield.bind(this));
    // Give command window a reference to status window for height matching
    if (this._statusWindow) {
        this._actorCommandWindow._statusWindow = this._statusWindow;
    }
    console.log('Move handler set');
};

Scene_Battle.prototype.startActorCommandSelection = function() {
    if (BattleManager._waitingForDice) return; // dice still showing — don't open commands yet
    this._actorCommandWindow.show();
    this._actorCommandWindow.setup(BattleManager.actor());
};

// Stamp each targeted enemy's column at the moment the player confirms selection.
// If the enemy moves before the attack resolves, apply() detects the change and misses.
var _Scene_Battle_onEnemyOk = Scene_Battle.prototype.onEnemyOk;
Scene_Battle.prototype.onEnemyOk = function() {
    var enemy = this._enemyWindow ? this._enemyWindow.enemy() : null;
    if (enemy) enemy._columnAtTargeting = enemy.battlePosition();
    _Scene_Battle_onEnemyOk.call(this);
};

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

    // Start walk-in-place cycle immediately when Move is selected
    var moveSprite = this.getActorSprite(actor);
    if (moveSprite && moveSprite.startMotion) {
        moveSprite.startMotion('walk', true);
    }
    
    console.log('Move window shown and active');
};

Scene_Battle.prototype.onMoveForward = function() {
    console.log('=== MOVE FORWARD SELECTED ===');
    const actor = this._moveActor;
    if (!actor) { this.cancelMove(); return; }
    actor._moveDirection = 'forward';
    actor._moveModifier = 1;
    console.log(actor.name(), 'will move forward with +1 modifier');
    BattleManager._targetIndex = -1;
    this.completeMove(actor);
};

Scene_Battle.prototype.onMoveBack = function() {
    console.log('=== MOVE BACK SELECTED ===');
    const actor = this._moveActor;
    if (!actor) { this.cancelMove(); return; }
    actor._moveDirection = 'back';
    actor._moveModifier = -1;
    console.log(actor.name(), 'will move back with -1 modifier');
    BattleManager._targetIndex = -1;
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

//=============================================================================
// Move Animation System
//=============================================================================

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

        // Store direction for execution-phase animation.
        // Do NOT call moveForward/moveBackward here — the logical position
        // change and sprite slide both happen in playMoveAnimation on the
        // actor's turn, so the slide starts from the correct current position.
        actor._pendingMoveDir = dir;
        actor._moveDirection = null;
        actor._moveModifier = 0;
        actor._moveAction = false;

        // Walk cycle started in onMove already; keep it going.

        if (actor.inputtingAction && actor.inputtingAction()) {
            actor.inputtingAction().setGuard();
        }
    }

    BattleManager.selectNextCommand();
};


//=============================================================================
// Shield Intercept Window
// Prompts an actor to activate Shield when targeted by an Attack spell.
//=============================================================================

function Window_ShieldIntercept() { this.initialize.apply(this, arguments); }
Window_ShieldIntercept.prototype = Object.create(Window_Command.prototype);
Window_ShieldIntercept.prototype.constructor = Window_ShieldIntercept;

Window_ShieldIntercept.prototype.initialize = function(x, y) {
    this._actor = null;
    Window_Command.prototype.initialize.call(this, x, y);
    this.hide();
    this.deactivate();
};

Window_ShieldIntercept.prototype.windowWidth  = function() { return 340; };
Window_ShieldIntercept.prototype.numVisibleRows = function() { return Math.min(8, this.maxItems()); };

Window_ShieldIntercept.prototype.setActor = function(actor) {
    this._actor = actor;
    this.refresh();
};

Window_ShieldIntercept.prototype.makeCommandList = function() {
    if (!this._actor) return;
    var sePool     = this._actor.spellEnergy ? this._actor.spellEnergy() : 0;
    var skillLevel = this._actor.tdarnSkillLevel ? this._actor.tdarnSkillLevel('Shield') : 0;
    var powLevel   = this._actor.powerLevel ? this._actor.powerLevel() : 0;
    var maxLevel   = skillLevel + powLevel;
    for (var i = 1; i <= maxLevel; i++) {
        var pool   = i * 10;
        var canUse = sePool >= i;
        this.addCommand('Shield Lv' + i + '  (' + pool + ' HP — ' + i + ' SE)', 'shield' + i, canUse);
    }
    this.addCommand('Do not activate shield', 'noShield', true);
};

var _Scene_Battle_createAllWindows_shield = Scene_Battle.prototype.createAllWindows;
Scene_Battle.prototype.createAllWindows = function() {
    _Scene_Battle_createAllWindows_shield.call(this);
    this._shieldInterceptWindow = new Window_ShieldIntercept(0, 0);
    this._shieldInterceptWindow.x = Math.floor((Graphics.boxWidth  - 340) / 2);
    this._shieldInterceptWindow.y = Math.floor((Graphics.boxHeight - 240) / 2);
    this.addWindow(this._shieldInterceptWindow);
    for (var i = 1; i <= 40; i++) {
        this._shieldInterceptWindow.setHandler('shield' + i, this.onShieldInterceptLevel.bind(this, i));
    }
    this._shieldInterceptWindow.setHandler('noShield', this.onShieldInterceptNo.bind(this));
};

Scene_Battle.prototype.showShieldIntercept = function(actor) {
    this._shieldInterceptWindow.setActor(actor);
    this._shieldInterceptWindow.refresh();
    this._shieldInterceptWindow.show();
    this._shieldInterceptWindow.activate();
    this._shieldInterceptWindow.select(0);
};

Scene_Battle.prototype.onShieldInterceptLevel = function(level) {
    var actor = BattleManager._shieldInterceptActor;
    if (actor && actor.consumeSpellEnergy) actor.consumeSpellEnergy(level);
    if (actor) actor.activateShield(level);
    this._shieldInterceptWindow.hide();
    this._shieldInterceptWindow.deactivate();
    BattleManager._waitingForShield    = false;
    BattleManager._shieldInterceptActor = null;
    BattleManager.applyPendingSpellDamage();
};

Scene_Battle.prototype.onShieldInterceptNo = function() {
    this._shieldInterceptWindow.hide();
    this._shieldInterceptWindow.deactivate();
    BattleManager._waitingForShield    = false;
    BattleManager._shieldInterceptActor = null;
    BattleManager.applyPendingSpellDamage();
};

BattleManager.applyPendingSpellDamage = function() {
    var p = BattleManager._pendingSpellDamage;
    if (!p) return;
    BattleManager._pendingSpellDamage = null;
    p.action.applySpellDamage(p.target, p.isNatural20, p.skill);
    BattleManager._phase = 'turn';
    BattleManager.processTurn();
};


//=============================================================================
// Van Pre-Attack Step Animation
//
// When a Van (col 3) actor attacks with short range or unarmed, the sprite
// briefly steps toward the enemy Van column before attacking, then returns.
// This is purely visual — no column change, no turn cost.
//=============================================================================

var _Game_Actor_performAction_step = Game_Actor.prototype.performAction;
Game_Actor.prototype.performAction = function(action) {
    _Game_Actor_performAction_step.call(this, action);
    if (this.battlePosition() !== 3) return;
    var skill  = action.item ? action.item() : null;
    var isSpell = skill && skill.meta && (skill.meta.spellLevel || skill.meta.spellType);
    if (isSpell) return;
    var weapon = this.weapons ? this.weapons()[0] : null;
    var range  = getWeaponRange(weapon);
    // Only step for short/unarmed (null = unarmed = 'short')
    if (range !== null && range !== 'short') return;

    // Find target — the first live enemy
    var targets = action.makeTargets ? action.makeTargets() : [];
    var target  = targets[0];
    if (!target || !target.isEnemy || !target.isEnemy()) return;

    // Step toward enemy Van X position
    var sprite = TDarn.getActorSprite(this);
    if (!sprite) return;
    sprite._vanStepOriginX = sprite._homeX;
    var stepX = TDarn.enemyColX(3) + 30; // just inside enemy Van column
    sprite._homeX = stepX;
    sprite._tdarnTargetX = stepX;
};

var _Game_Actor_performActionEnd_step = Game_Actor.prototype.performActionEnd;
Game_Actor.prototype.performActionEnd = function() {
    _Game_Actor_performActionEnd_step.call(this);
    var sprite = TDarn.getActorSprite(this);
    if (sprite && sprite._vanStepOriginX !== undefined) {
        sprite._tdarnTargetX = sprite._vanStepOriginX;
        sprite._vanStepOriginX = undefined;
    }
};

// Helper: find the Sprite_Actor for a given Game_Actor
TDarn.getActorSprite = function(actor) {
    var scene = SceneManager._scene;
    if (!scene || !scene._spriteset || !scene._spriteset._actorSprites) return null;
    var sprites = scene._spriteset._actorSprites;
    for (var i = 0; i < sprites.length; i++) {
        var sp = sprites[i];
        if ((sp._actor || sp._battler) === actor) return sp;
    }
    return null;
};


//=============================================================================
// Skill Note Tags
//
//   <skillRange: Short>          — skill only usable within this range band
//   <skillTarget: single>        — forces single-target regardless of DB setting
//   <skillTarget: aoe>           — hits all valid targets in range
//   <requireSkillLevel: Name N>  — skill hidden unless actor has SkillName >= N
//
//=============================================================================

// ── skillRange: restrict spell/skill range ────────────────────────────────
// Called from isInValidRange when the action is a skill with this tag.
TDarn.getSkillRange = function(skill) {
    if (!skill || !skill.meta || !skill.meta.skillRange) return null;
    return skill.meta.skillRange.trim().toLowerCase();
};

// Patch isInValidRange to respect skillRange tag on the action's skill
var _TDarn_isInValidRange_orig = isInValidRange;
isInValidRange = function(attacker, target) {
    // Check if the current action has a skillRange tag overriding weapon range
    var action = attacker.currentAction ? attacker.currentAction() : null;
    var skill  = action && action.item ? action.item() : null;
    var skillRange = TDarn.getSkillRange(skill);
    if (skillRange) {
        var distance = getRangeDistance(attacker, target);
        var minDist  = TDarn.RANGE_MINIMUMS[skillRange] !== undefined ? TDarn.RANGE_MINIMUMS[skillRange] : 0;
        var maxDist  = TDarn.RANGE_MAXIMUMS[skillRange] !== undefined ? TDarn.RANGE_MAXIMUMS[skillRange] : 4;
        return distance >= minDist && distance <= maxDist;
    }
    return _TDarn_isInValidRange_orig(attacker, target);
};

// ── requireSkillLevel: hide skill in menu if level not met ───────────────
var _Window_BattleSkill_includes = Window_BattleSkill.prototype.includes;
Window_BattleSkill.prototype.includes = function(item) {
    if (!_Window_BattleSkill_includes.call(this, item)) return false;
    if (!item || !item.meta || !item.meta.requireSkillLevel) return true;
    // Parse "SkillName N"
    var req = item.meta.requireSkillLevel.trim();
    var match = req.match(/^(.+?)\s+(\d+)$/);
    if (!match) return true;
    var reqName  = match[1].trim();
    var reqLevel = parseInt(match[2]);
    var actor    = this._actor;
    if (!actor || !actor.tdarnSkillLevel) return true;
    return actor.tdarnSkillLevel(reqName) >= reqLevel;
};

// Also hide from SP menu skill list
TDarn.skillMeetsLevelReq = function(actor, skill) {
    if (!skill || !skill.meta || !skill.meta.requireSkillLevel) return true;
    var req   = skill.meta.requireSkillLevel.trim();
    var match = req.match(/^(.+?)\s+(\d+)$/);
    if (!match) return true;
    return (actor.tdarnSkillLevel ? actor.tdarnSkillLevel(match[1].trim()) : 0) >= parseInt(match[2]);
};

const _BattleManager_processTurn = BattleManager.processTurn;
BattleManager.processTurn = function() {
    var subject = this._subject;
    if (subject) {
        subject._autoMovedThisTurn = false;
        subject._tdarnAutoMoved    = false;
    }

    // Actor move animation
    if (subject && subject.isActor && subject.isActor() && subject._pendingMoveDir) {
        var scene = SceneManager._scene;
        if (scene && scene.playMoveAnimation) {
            this._phase = 'animate';
            scene.playMoveAnimation(subject);
            return;
        }
    }

    // Enemy pending move execution — completes column change on their turn
    if (subject && subject.isEnemy && subject.isEnemy() && subject._pendingMoveDir) {
        var edir = subject._pendingMoveDir;
        subject._pendingMoveDir = null;
        subject._moveModifier   = 0;
        if (edir === 'forward') subject.moveForward();
        else                    subject.moveBackward();
        console.log('[AI] ' + subject.name() + ' completes move to column ' + subject.battlePosition());
        var ess = SceneManager._scene ? SceneManager._scene._spriteset : null;
        if (ess && ess.updateEnemyPositions) ess.updateEnemyPositions();
        this._subject = null;
        this.endAction();
        return;
    }

    // Enemy AI move — consumes the action if triggered
    if (subject && subject.isEnemy && subject.isEnemy() && !subject._aiMoveChecked) {
        subject._aiMoveChecked = true;
        if (TDarn.processEnemyAIMove(subject)) {
            if (BattleManager._lastCritEnemy === subject) BattleManager._lastCritEnemy = null;
            this._subject = null;
            this.endAction();
            return;
        }
        // If no AI move triggered, check whether the enemy's pending action is
        // a physical attack against a target that's out of range. If so, force
        // a move forward instead of wasting the action on a guaranteed miss.
        var action = subject.currentAction ? subject.currentAction() : null;
        if (action && !action.isGuard() && !action.isMagicSkill()) {
            var targets = action.makeTargets ? action.makeTargets() : [];
            var hasValidTarget = targets.some(function(t) {
                return isInValidRange(subject, t);
            });
            if (!hasValidTarget && targets.length > 0) {
                // Only advance if permitted (cap at closest actor column)
                var canMove = TDarn.enemyCanAdvance ? TDarn.enemyCanAdvance(subject) : (subject.battlePosition() < 3);
                if (canMove) {
                    console.log('[AI] ' + subject.name() + ' out of range — moving forward instead of attacking');
                    subject.moveForward();
                    var ss = SceneManager._scene ? SceneManager._scene._spriteset : null;
                    if (ss && ss.updateEnemyPositions) ss.updateEnemyPositions();
                } else {
                    console.log('[AI] ' + subject.name() + ' out of range but cannot advance further — action skipped');
                }
                this._subject = null;
                this.endAction();
                return;
            }
        }
    }

    // Actor auto-advance: if no valid target exists, move forward and end action.
    // Done HERE so MV never fires startAction / performAction / animation.
    if (subject && subject.isActor && subject.isActor()) {
        var actAction = subject.currentAction ? subject.currentAction() : null;
        if (actAction && !actAction.isGuard()) {
            var actSkill = actAction.item ? actAction.item() : null;
            var actIsSpell = actSkill && actSkill.meta && (actSkill.meta.spellLevel || actSkill.meta.spellType);
            if (!actIsSpell && !TDarn.hasValidTarget(subject)) {
                console.log('[RANGE] ' + subject.name() + ' no valid target — auto-advancing, no attack.');
                $gameMessage.add(subject.name() + ' moves forward!');
                subject.moveForward();
                var aps = SceneManager._scene ? SceneManager._scene._spriteset : null;
                if (aps && aps.updateActorPositions) aps.updateActorPositions();
                this._subject = null;
                this.endAction();
                return;
            }
        }
    }

    _BattleManager_processTurn.call(this);
};

Scene_Battle.prototype.onLowerShield = function() {
    var actor = BattleManager.actor();
    if (actor) {
        actor.dropShield();
        $gameMessage.add(actor.name() + ' lowers their shield.');
    }
    // Does not consume a turn — return to command selection
    this._actorCommandWindow.refresh();
    this._actorCommandWindow.activate();
};

Scene_Battle.prototype.playMoveAnimation = function(actor) {
    var sprite = this.getActorSprite(actor);
    var dir = actor._pendingMoveDir;
    actor._pendingMoveDir = null;

    var DURATION = 20;
    var spriteset = this._spriteset;

    // Compute the destination column and X BEFORE moving the actor logically.
    // The actor's _battleColumn still reflects their PRE-move position here.
    var currentCol = actor.battlePosition();
    var destCol = currentCol;
    if (dir === 'forward' && currentCol < 3) destCol = currentCol + 1;
    else if (dir === 'back' && currentCol > 0) destCol = currentCol - 1;

    var startX = sprite ? sprite._homeX : TDarn.actorColX(currentCol);
    var destX   = TDarn.actorColX(destCol);

    var finish = function() {
        // NOW apply the logical position change — animation is complete.
        if (dir === 'forward') {
            actor.moveForward();
        } else if (dir === 'back') {
            actor.moveBackward();
        }
        // updateActorPositions will snap _homeX to the correct column X.
        if (spriteset) spriteset.updateActorPositions();
        if (sprite && sprite.setDirection) sprite.setDirection(4);
        if (sprite && sprite.startMotion) sprite.startMotion('wait', true);
        BattleManager._phase = 'turn';
        _BattleManager_processTurn.call(BattleManager);
    };

    if (!sprite || destCol === currentCol) { finish(); return; }

    // Walk motion should already be running from onMove; ensure it's active.
    if (sprite.setDirection) sprite.setDirection(4);
    if (sprite.startMotion) sprite.startMotion('walk', true);

    // Set _homeX to dest so the lerp system doesn't fight the animation.
    sprite._homeX = destX;
    sprite._tdarnTargetX = destX;

    this._moveAnimTimer = 0;
    this._moveAnimDuration = DURATION;
    this._moveAnimStartX = startX;
    this._moveAnimDestX = destX;
    this._moveAnimSprite = sprite;
    this._moveAnimFinish = finish;
};

const _Scene_Battle_update = Scene_Battle.prototype.update;
Scene_Battle.prototype.update = function() {
    _Scene_Battle_update.call(this);
    if (this._diceLayer) this._diceLayer.update();
    if (this._moveAnimTimer !== null && this._moveAnimTimer !== undefined) {
        this._moveAnimTimer++;
        var sp = this._moveAnimSprite;
        if (sp && this._moveAnimDuration > 0) {
            var t = Math.min(this._moveAnimTimer / this._moveAnimDuration, 1);
            sp.x = this._moveAnimStartX + (this._moveAnimDestX - this._moveAnimStartX) * t;
        }
        if (this._moveAnimTimer >= this._moveAnimDuration) {
            if (sp) sp.x = this._moveAnimDestX;
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
    console.log('Party members:', $gameParty.members().map(function(m) { return m.name(); }));
    console.log('Troop members:', $gameTroop.members().map(function(m) { return m.name(); }));
    // Load any penalties tagged on the troop, clear previous troop penalties
    TDarn.loadTroopPenalties();
    // Reset each actor's live battle column to their formation default
    $gameParty.members().forEach(function(actor) {
        actor.resetBattleColumn();
        console.log('[FORMATION] ' + actor.name() + ' reset to default column ' + actor.defaultBattleColumn());
    });
    // Reset each enemy's live column and AI flags
    $gameTroop.members().forEach(function(enemy) {
        enemy.resetBattleColumn();
        console.log('[FORMATION] ' + enemy.name() + ' reset to default column ' + enemy.battlePosition());
    });
    BattleManager._lastCritEnemy = null;
    _Scene_Battle_start.call(this);
};

BattleManager.startInput = function() {
    console.log('=== START INPUT ===');
    this._phase = 'input';
    this._actorIndex = -1;

    $gameParty.makeActions();
    $gameTroop.makeActions();

    var everyone = $gameParty.aliveMembers().concat($gameTroop.aliveMembers());
    everyone.forEach(function(b) { b._initiative = null; });

    this.makeActionOrders();

    if (this._actionBattlers) {
        console.log('Initiative order:', this._actionBattlers.map(function(b) {
            return b.name() + '(' + b._initiative + ')';
        }).join(', '));

        // Show a d20 sprite above every battler with their initiative roll
        var seen = [];
        this._actionBattlers.forEach(function(b, idx) {
            if (seen.indexOf(b) >= 0) return;
            seen.push(b);
            var d20raw = b._initiative - (b.agi || 0);
            var rollData = {
                attacker: b,
                defender: null,
                rolls: [{
                    die:   20,
                    raw:   d20raw,
                    mods:  [{label: 'AGI', val: b.agi || 0}],
                    total: b._initiative,
                    label: 'Init'
                }],
                result: '',
                detail: ''
            };
            // First battler clears and starts the layer; rest append
            if (seen.length === 1) {
                TDarn.showRoll(rollData);
            } else {
                TDarn.appendRoll(rollData);
            }
        });

        // Block input until player dismisses the initiative dice
        // Store callback that finishes startInput after dismiss
        var self = this;
        BattleManager._diceRollCallback = function() {
            self.clearActor();
            $gameParty.battleMembers().forEach(function(actor) {
                if (actor.canMove()) actor.setActionState('inputting');
            });
            if (self._surprise || !$gameParty.canInput()) {
                self.startTurn();
            } else {
                self.selectNextCommand();
                var scene = SceneManager._scene;
                if (scene && scene.startActorCommandSelection && BattleManager.actor()) {
                    scene.startActorCommandSelection();
                }
            }
        };
        return; // don't fall through — callback fires on dismiss
    }

    $gameParty.battleMembers().forEach(function(actor) {
        if (actor.canMove()) actor.setActionState('inputting');
    });

    this.clearActor();
    if (this._surprise || !$gameParty.canInput()) {
        this.startTurn();
    }
};


//=============================================================================
// Dead-Time Tracking (for Revive spell DC)
//
// Each turn a dead battler goes without being revived adds 0.5 minutes.
// Out of battle, each step = 0.5 minutes (approximated).
// minutesDead = _turnsDead * 0.5
// Revive DC = spell level - minutesDead  (need d20 LOWER than DC)
//=============================================================================

Game_Battler.prototype.minutesDead = function() {
    return (this._turnsDead || 0) * 0.5;
};

Game_Battler.prototype.incrementDeadTime = function() {
    if (this.isDead()) {
        this._turnsDead = (this._turnsDead || 0) + 1;
    }
};

Game_Battler.prototype.clearDeadTime = function() {
    this._turnsDead = 0;
};

// Hook: increment dead time for all dead battlers each turn execution start
BattleManager.startTurn = function() {
    console.log('=== START TURN: execution phase ===');
    console.log('Turn order:', this._actionBattlers.map(function(b) { return b.name(); }));
    // Reset per-turn AI move flag and clear previous round's crit record
    $gameTroop.aliveMembers().forEach(function(e) { e._aiMoveChecked = false; });
    BattleManager._lastCritEnemy = null;
    // Increment dead time for all dead battlers
    $gameParty.members().forEach(function(a) { a.incrementDeadTime(); });
    $gameTroop.members().forEach(function(e) { e.incrementDeadTime(); });
    this._phase = 'turn';
    if (this._logWindow) this._logWindow.clear();
    this._subject = this.getNextSubject();
};

BattleManager.getNextSubject = function() {
    for (;;) {
        var battler = this._actionBattlers.shift();
        if (!battler) return null;
        if (battler.isBattleMember() && battler.isAlive()) return battler;
    }
};

//=============================================================================
// Firearm System
//=============================================================================

Game_Action.prototype.applyFirearmEffects = function(subject, target) {
    const weapon = subject.weapons ? subject.weapons()[0] : null;
    if (!weapon || !weapon.meta || !weapon.meta.recoil) return;
    const recoil = getRecoil(weapon);
    const bod = subject.atk;
    if (recoil > bod * 2) {
        target.addState(11);
        if (subject.moveBackward) subject.moveBackward();
        console.log(subject.name() + ' is knocked back by massive recoil!');
    }
};

Game_Action.prototype.checkOverpenetration = function(target, damage) {
    const bod = target.atk;
    const weapon = this.subject().weapons ? this.subject().weapons()[0] : null;
    if (!weapon) return false;
    let threshold = bod;
    if (weapon.meta && weapon.meta.armorPiercing) threshold = Math.ceil(bod / 2);
    return damage > threshold;
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
            combatants.sort(function(a, b) { return b._initiative - a._initiative; })
                .forEach(function(b) { msg += b.name() + ': ' + b._initiative + '\n'; });
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
            console.log('Action battlers:', BattleManager._actionBattlers ? BattleManager._actionBattlers.map(function(b) { return b.name(); }) : 'none');
            console.log('Subject:', BattleManager._subject ? BattleManager._subject.name() : 'none');
        }
    }
};

//=============================================================================
// Game_Actor/Enemy Extensions
//=============================================================================

Game_Actor.prototype.weapons = function() {
    return this.equips().filter(function(item) { return item && DataManager.isWeapon(item); });
};

Game_Actor.prototype.armors = function() {
    return this.equips().filter(function(item) { return item && DataManager.isArmor(item); });
};

Game_Enemy.prototype.weapons = function() { return []; };
Game_Enemy.prototype.armors = function() { return []; };
Game_Enemy.prototype.name = function() { return this.enemy().name; };
Game_Enemy.prototype.level = function() { return 1; };

// Yanfly BattleEngineCore compatibility
if (typeof Window_BattleEnemy !== 'undefined') {
    // Grey out enemies the current actor cannot reach
    Window_BattleEnemy.prototype.isEnabled = function(enemy) {
        var actor = BattleManager.actor();
        if (!actor) return true;
        // Spells always show all targets (range handled at cast time)
        var action = actor.inputtingAction ? actor.inputtingAction() : null;
        var skill   = action && action.item ? action.item() : null;
        var isSpell = skill && skill.meta && (skill.meta.spellLevel || skill.meta.spellType);
        if (isSpell) return true;
        return isInValidRange(actor, enemy);
    };

    Window_BattleEnemy.prototype.drawItem = function(index) {
        this.resetTextColor();
        var enemy  = this._enemies[index];
        var rect   = this.itemRectForText(index);
        var enabled = this.isEnabled(enemy);
        this.changePaintOpacity(enabled);
        this.drawText(enemy.name(), rect.x, rect.y, rect.width);
        this.changePaintOpacity(true);
    };

    // Prevent OK on greyed-out enemies
    var _Window_BattleEnemy_isOkEnabled = Window_BattleEnemy.prototype.isOkEnabled;
    Window_BattleEnemy.prototype.isOkEnabled = function() {
        if (BattleManager._waitingForDice) return false;
        if (!_Window_BattleEnemy_isOkEnabled.call(this)) return false;
        var enemy = this.enemy();
        if (!enemy) return false;
        return this.isEnabled(enemy);
    };
}

if (typeof Window_BattleEnemy !== 'undefined' && Window_BattleEnemy.prototype.updateHelp) {
    var _Window_BattleEnemy_updateHelp = Window_BattleEnemy.prototype.updateHelp;
    Window_BattleEnemy.prototype.updateHelp = function() {
        var actor = BattleManager.actor();
        if (actor && !actor.currentAction()) return;
        _Window_BattleEnemy_updateHelp.call(this);
    };
}

//=============================================================================
// T-DARN STAT SYSTEM
//
// T-Darn stats map directly to RPGMaker MV's built-in parameters.
// Rename these in Database → Terms → Parameters to match:
//
//   MV param  param ID  Rename to  T-Darn meaning
//   --------  --------  ---------  ----------------------------------------
//   MHP       0         Wound Pts  Auto-computed as BOD*2 (see below)
//   MMP       1         (free)     Spell energy pool if needed
//   ATK       2         BOD        Strength & toughness; drives HP & damage
//   DEF       3         (keep)     Physical defense layer (future use)
//   MAT       4         INT        Intelligence / Brains; spellpower
//   MDF       5         WILL       Willpower; SP pool = WILL*5
//   AGI       6         AGI        Agility; initiative & combat rolls
//   LUK       7         AWARE      Awareness; perception & notice
//
// Set each actor's base stats in Database → Actors → Parameters at level 1.
// Class growth curves control how stats scale with level — at level 1 with
// flat curves this is identical to the TTRPG. If you later enable leveling,
// set class growth curves so BOD/AGI/etc increase as desired.
//
// Social is not a combat stat. Store it as a note tag <social: 9> on actors.
// Cash = Social * 100 is displayed in the Skills menu.
//
// MHP (Wound Points) = BOD * 2 at all times.
// The plugin overrides paramBase(0) to enforce this so you never need to
// manually set MHP in the database — just set BOD (ATK param) correctly.
//
// Enemies use note tags for all stats since they don't have class curves:
//   <bod: 8> <agi: 6> <int: 5> <will: 5> <aware: 6>
//=============================================================================

// ── Stat accessors — read from MV params so leveling works natively ───────
//
// For actors: param(N) goes through MV's full pipeline:
//   base (class curve at current level)
//   + equipment bonuses
//   + state buffs/debuffs
//   + paramPlus adjustments
// This means buff/debuff spells, equipment, and level growth all work
// without any extra code.
//
// For enemies: note tags supply base values since they have no class curves.

Game_Actor.prototype.tdarnBod    = function() { return this.param(2); }; // ATK renamed BOD
Game_Actor.prototype.tdarnInt    = function() { return this.param(4); }; // MAT renamed INT
Game_Actor.prototype.tdarnWill   = function() { return this.param(5); }; // MDF renamed WILL
Game_Actor.prototype.tdarnAgi    = function() { return this.param(6); }; // AGI
Game_Actor.prototype.tdarnAware  = function() { return this.param(7); }; // LUK renamed AWARE
// param slot summary:
//   0=MHP (BOD*2, auto)  1=MMP→POW  2=ATK→BOD  3=DEF(zeroed)
//   4=MAT→INT  5=MDF→WILL  6=AGI  7=LUK→AWARE
// Set POW in Database → Actors/Classes → Parameters, MMP column.
// Rename MMP to POW in Database → Terms → Parameters for clarity.
Game_Actor.prototype.tdarnSocial = function() {
    var meta = this.actor() ? this.actor().meta : {};
    return parseInt(meta.social) || 0;
};

Game_Enemy.prototype.tdarnBod    = function() { return parseInt(this.enemy().meta.bod)    || 8;  };
Game_Enemy.prototype.tdarnAgi    = function() { return parseInt(this.enemy().meta.agi)    || 6;  };
Game_Enemy.prototype.tdarnInt    = function() { return parseInt(this.enemy().meta.int)    || 5;  };
Game_Enemy.prototype.tdarnWill   = function() { return parseInt(this.enemy().meta.will)   || 5;  };
Game_Enemy.prototype.tdarnAware  = function() { return parseInt(this.enemy().meta.aware)  || 6;  };
Game_Enemy.prototype.tdarnSocial = function() { return 0; };

// ── MHP = BOD * 2, enforced via paramBase override ───────────────────────
//
// Overriding paramBase(0) means the engine's own mhp property always returns
// BOD*2. You do NOT need to set MHP values in the database. Class growth for
// MHP is ignored — the formula is always BOD*2.
// Equipment that adds +MHP still works via _paramPlus on top of this base.

var _Game_Actor_paramBase_stats = Game_Actor.prototype.paramBase;
Game_Actor.prototype.paramBase = function(paramId) {
    if (paramId === 0) {
        // Wound Points = BOD * 2. param(2) is the raw BOD without HP bonus loop.
        // Read _classBaseParam directly to avoid circular paramBase(0) → param(2) calls.
        var bod = _Game_Actor_paramBase_stats.call(this, 2);
        return bod * 2;
    }
    if (paramId === 3) return 0; // DEF unused — T-Darn uses armor items instead
    return _Game_Actor_paramBase_stats.call(this, paramId);
};

var _Game_Enemy_paramBase_stats = Game_Enemy.prototype.paramBase;
Game_Enemy.prototype.paramBase = function(paramId) {
    if (paramId === 0) {
        return this.tdarnBod() * 2;
    }
    if (paramId === 3) return 0; // DEF unused
    return _Game_Enemy_paramBase_stats.call(this, paramId);
};

// ── SP pool initialisation (WILL * 5) ────────────────────────────────────
// SP is tracked on the actor directly. Initialise once on setup, then WILL
// changes via leveling automatically raise the EP max next time it's read.

var _Game_Actor_setup_stats = Game_Actor.prototype.setup;
Game_Actor.prototype.setup = function(actorId) {
    _Game_Actor_setup_stats.call(this, actorId);
    if (!this._tdarnSkills)  this._tdarnSkills  = {};
    if (!this._tdarnSkillSp) this._tdarnSkillSp = {};
    this.loadTDarnStartingSkills();
};

// Load starting skill levels from actor note tags.
// Tag format (one per line in the actor's Notes box):
//   <skill: Unarmed 18>
//   <skill: Attack 4>
//   <skill: Stealth 7>
// Only sets the level if not already set — safe to call on reload.
Game_Actor.prototype.loadTDarnStartingSkills = function() {
    var meta = this.actor() ? this.actor().meta : {};
    // meta.skill is a single string if one tag, or RPGMaker won't parse multiples
    // into meta directly — we need to parse the raw note instead.
    var note = this.actor() ? (this.actor().note || '') : '';
    var re   = /<skill:\s*([^0-9]+?)\s+(\d+)>/gi;
    var m;
    while ((m = re.exec(note)) !== null) {
        var skillName = m[1].trim();
        var level     = Math.max(0, Math.min(20, parseInt(m[2])));
        if (!this._tdarnSkills[skillName]) {  // don't overwrite SP-earned progress
            this._tdarnSkills[skillName] = level;
            console.log('[SKILL] ' + this.name() + ' starting ' + skillName + ': ' + level);
        }
    }
};



// Helper used in combat rolls — kept for any code that calls them explicitly
function getTDarnAgi(battler) {
    return battler.tdarnAgi ? battler.tdarnAgi() : (battler.param ? battler.param(6) : 0);
}
function getTDarnBod(battler) {
    return battler.tdarnBod ? battler.tdarnBod() : (battler.param ? battler.param(2) : 0);
}
function getTDarnAware(battler) {
    return battler.tdarnAware ? battler.tdarnAware() : (battler.param ? battler.param(7) : 0);
}

//=============================================================================
// SKILL SYSTEM
//
// Skills are stored as _tdarnSkills = { 'Sword': 5, 'Firearms': 3, ... }
// on each Game_Actor. Range 1-20, start with a 75-point pool to distribute.
//
// Weapon note tag: <weaponType: Sword>
// Links a weapon item to a skill category. The actor's level in that skill
// adds to their attack roll (replaces the old note-tag-on-weapon approach).
//
// Skill EP (Experience Points — T-Darn's advancement currency):
// Completely separate from RPGMaker MP/EXP.
// Each battle use of a skill earns 1 SP toward that skill.
// SP thresholds for level-up: currentLevel * 10 EP needed to reach next level.
// Example: going from skill 5 to 6 costs 50 SP.
//
// Note: T-Darn's EP system is NOT RPGMaker's experience points.
// RPGMaker EXP still exists but is ignored for stat growth.
// T-Darn progression = spending EP on individual skills only.
//=============================================================================

// ── Skill accessors ───────────────────────────────────────────────────────

Game_Actor.prototype.initTDarnSkills = function() {
    if (!this._tdarnSkills)               this._tdarnSkills               = {};
    if (!this._tdarnSkillSp)              this._tdarnSkillSp              = {};
    if (!this._tdarnSpEarnedThisBattle)   this._tdarnSpEarnedThisBattle   = {};
};

Game_Actor.prototype.tdarnSkillLevel = function(skillName) {
    this.initTDarnSkills();
    return this._tdarnSkills[skillName] || 0;
};

Game_Actor.prototype.setTDarnSkill = function(skillName, level) {
    this.initTDarnSkills();
    this._tdarnSkills[skillName] = Math.max(0, Math.min(20, level));
};

// SP accumulated toward the next level of a specific skill this battle
Game_Actor.prototype.tdarnSkillSp = function(skillName) {
    this.initTDarnSkills();
    return this._tdarnSkillSp[skillName] || 0;
};

// SP needed to advance from current level to next.
// Formula: 10 + current level (book rule).
// level 0→1 = 10, 1→2 = 11, 5→6 = 15, 19→20 = 29.
Game_Actor.prototype.tdarnSkillSpNeeded = function(skillName) {
    var level = this.tdarnSkillLevel(skillName);
    if (level >= 20) return Infinity;
    return 10 + level;
};

// Award SP for using a skill; auto-level if threshold reached
Game_Actor.prototype.gainTDarnSkillSp = function(skillName, amount) {
    if (!skillName) return;
    this.initTDarnSkills();
    amount = amount || 1;
    var before = this._tdarnSkillSp[skillName] || 0;
    this._tdarnSkillSp[skillName] = before + amount;
    var needed = this.tdarnSkillSpNeeded(skillName);
    console.log("[SP] " + this.name() + " " + skillName + ": " + before + " + " + amount + " = " + this._tdarnSkillSp[skillName] + " / " + needed + " needed");
    while (this._tdarnSkillSp[skillName] >= needed && needed !== Infinity) {
        this._tdarnSkillSp[skillName] -= needed;
        var newLevel = (this._tdarnSkills[skillName] || 0) + 1;
        this._tdarnSkills[skillName] = Math.min(20, newLevel);
        needed = this.tdarnSkillSpNeeded(skillName);
        console.log("[SP] " + this.name() + " " + skillName + " levelled up to " + newLevel + "! SP remaining: " + this._tdarnSkillSp[skillName]);
        if (SceneManager._scene && SceneManager._scene._logWindow) {
            SceneManager._scene._logWindow.addText(
                this.name() + "'s " + skillName + " skill advanced to " + newLevel + "!"
            );
        }
    }
};

// ── Weapon type helper ────────────────────────────────────────────────────
// Reads the weapon type name directly from the MV database (System > Weapon Types).
// weapon.wtypeId is the index into $dataSystem.weaponTypes[].
// No note tag needed — just assign the correct weapon type in the database editor.

function getWeaponType(weapon) {
    if (!weapon) return null;
    var wtypeId = weapon.wtypeId;
    if (wtypeId && $dataSystem && $dataSystem.weaponTypes) {
        return $dataSystem.weaponTypes[wtypeId] || null;
    }
    return null;
}

// ── Patch getWeaponSkill to use actor's trained skill level ──────────────
// Old: read weaponSkill note tag from the weapon item itself (a fixed number).
// New: look up the actor's trained level in the weapon's category.
// Weapon note tag <weaponType: Sword> → actor._tdarnSkills['Sword']
// Falls back to old <weaponSkill: N> tag for backwards compatibility.

var _getWeaponSkill_orig = getWeaponSkill; // preserve for fallback
getWeaponSkill = function(weapon, actor) {
    if (!weapon) return 0;
    // Prefer weapon type skill from actor if actor is provided
    if (actor && actor.tdarnSkillLevel) {
        var wType = getWeaponType(weapon);
        if (wType) {
            return actor.tdarnSkillLevel(wType);
        }
    }
    // Fallback: old static note tag on weapon
    return parseInt(weapon.meta.weaponSkill) || 0;
};

//=============================================================================
// PATCH COMBAT ROLLS TO USE T-DARN STATS + WEAPON SKILLS
//=============================================================================

// Patch Game_Action.apply to pass subject into getWeaponSkill
// and use getTDarnAgi() instead of .agi
// Game_Action.apply is fully overridden earlier in this file.

// ── .agi and .atk are no longer overridden ───────────────────────────────
// MV's native .agi (param 6) IS AGI. MV's native .atk (param 2) IS BOD.
// tdarnAgi() and tdarnBod() call param(6) and param(2) respectively,
// so all combat code using battler.agi / battler.atk reads T-Darn stats
// through the normal MV param pipeline — buffs, equipment, and level
// growth all apply automatically with no extra code.

//=============================================================================
// PATCH getWeaponSkill CALLS IN apply() TO PASS SUBJECT
//
// The existing apply() override calls getWeaponSkill(weapon) without an actor.
// We need to patch those specific call sites to pass the subject.
// This is done by redefining the combat helpers as closures that capture
// the subject from the action context.
//=============================================================================

// Wrap the existing apply to inject subject into getWeaponSkill calls
// by temporarily binding it on the weapon object during the call.
var _Game_Action_apply_wrap = Game_Action.prototype.apply;
Game_Action.prototype.apply = function(target) {
    var subject = this.subject();
    var weapon  = subject && subject.weapons ? subject.weapons()[0] : null;
    // Temporarily store subject on weapon so getWeaponSkill can find it
    if (weapon && subject) weapon._tdarnSubject = subject;
    _Game_Action_apply_wrap.call(this, target);
    if (weapon) delete weapon._tdarnSubject;
};

// Update getWeaponSkill to read _tdarnSubject from weapon if no actor passed
var _getWeaponSkill_prev = getWeaponSkill;
getWeaponSkill = function(weapon, actor) {
    if (!weapon) return 0;
    var resolvedActor = actor || (weapon._tdarnSubject) || null;
    if (resolvedActor && resolvedActor.tdarnSkillLevel) {
        var wType = getWeaponType(weapon);
        if (wType) {
            var level = resolvedActor.tdarnSkillLevel(wType);
            return level;
        }
    }
    return parseInt(weapon.meta.weaponSkill) || 0;
};

//=============================================================================
// SP AWARD ON ACTION EXECUTION — once per skill per battle, hit OR miss
//
// Rules:
//   - 1 SP awarded when the actor actually performs the action (not on select).
//   - Hit or miss doesn't matter — the attempt is what counts.
//   - Only 1 SP per skill per battle (scene), no matter how many times used.
//   - EP is NOT awarded if the action is selected but the battle ends before
//     the actor's turn comes (flag is set only when apply() runs).
//   - New skill (level 0): 10 SP to reach level 1, same as any other advance.
//
// Implementation:
//   actor._tdarnSpEarnedThisBattle = { 'Sword': true, 'Magic': true, ... }
//   Reset to {} at battle start via Scene_Battle.start hook.
//   EP awarded inside the apply() wrapper, which only runs during execution.
//=============================================================================

// Reset per-battle EP tracking when a new battle starts
var _Scene_Battle_start_ep = Scene_Battle.prototype.start;
Scene_Battle.prototype.start = function() {
    _Scene_Battle_start_ep.call(this);
    $gameParty.members().forEach(function(actor) {
        actor._tdarnSpEarnedThisBattle = {};
        console.log("[SP] Reset SP battle tracking for " + actor.name());
    });
};

// Award EP when an actor executes their action — fires inside apply(),
// which only runs when the action actually takes place in the turn order.
var _Game_Action_apply_ep = Game_Action.prototype.apply;
Game_Action.prototype.apply = function(target) {
    var subject = this.subject();

    if (subject && subject.isActor && subject.isActor()) {
        var skill   = this.item();
        var weapon  = subject.weapons ? subject.weapons()[0] : null;
        var skillName = null;

        if (this.isGuard && this.isGuard()) {
            // Move action guard — no SP
            skillName = null;
        } else if (skill && skill.meta && (skill.meta.spellLevel || skill.meta.spellType)) {
            // Spell or POW-using ability — award SP to spell type.
            var rawType = skill.meta.spellType ? skill.meta.spellType.trim() : null;
            skillName = rawType || "Magic";
        } else {
            // Attack or battle skill — use equipped weapon type name from DB.
            // Set weapon type in Database > System > Weapon Types and assign
            // it to each weapon in Database > Weapons > Type dropdown.
            skillName = getWeaponType(weapon) || "Unarmed";
        }

        console.log("[SP] " + subject.name() + " used " + (skill ? skill.name : "?") + " [" + (weapon ? weapon.name + " wtypeId=" + weapon.wtypeId : "no weapon") + "] -> skill: " + skillName);

        if (skillName) {
            if (!subject._tdarnSpEarnedThisBattle) {
                subject._tdarnSpEarnedThisBattle = {};
            }
            if (!subject._tdarnSpEarnedThisBattle[skillName]) {
                subject._tdarnSpEarnedThisBattle[skillName] = true;
                subject.gainTDarnSkillSp(skillName, 1);
                console.log("[SP] Awarded 1 SP to " + subject.name() + " for " + skillName + " (first use this battle)");
            } else {
                console.log("[SP] " + subject.name() + " already earned SP for " + skillName + " this battle — skipping");
            }
        }
    }

    _Game_Action_apply_ep.call(this, target);
};


//=============================================================================
// SP SYSTEM — SKILLS & EP MENU
//
// Three sections:
//   Weapon Skills  — Unarmed first, then all weapon types from the DB
//   Magic Skills   — spells/techniques the character knows
//   Character Skills — non-combat / non-magic skills
//
// Top level: Section list (left) + Actor list (right)
// Second level: Skill list for that section showing level pips + SP progress
// Spending EP: select a skill, press OK, confirm to spend (10 + currentLevel) SP
//=============================================================================

// ── Skill category definitions ─────────────────────────────────────────────
// Character Skills are fixed. Weapon Skills are built dynamically from
// $dataSystem.weaponTypes at menu open time so they always match the DB.
// Magic Skills are built from skills in the database that have <spellLevel:> meta.

TDarn.CHAR_SKILLS = [
    "Dodge", "Athletics", "Stealth", "Awareness",
    "Medicine", "Engineering", "Driving", "Swimming", "Social", "Leadership"
];

// Weapon types come from $dataSystem.weaponTypes (index 1+), Unarmed first.
// Note: only add actual weapon types here. Character skills like Flight
// should NOT be in the database weapon types list — they will auto-classify
// as Character Skills if they are not weapon or magic type names.
TDarn.getWeaponSkillNames = function() {
    var list = ["Unarmed"];
    if ($dataSystem && $dataSystem.weaponTypes) {
        for (var i = 1; i < $dataSystem.weaponTypes.length; i++) {
            var t = $dataSystem.weaponTypes[i];
            if (t && list.indexOf(t) === -1) list.push(t);
        }
    }
    return list;
};

// Magic SP tracks T-Darn spell TYPES plus Chi (brawler).
// Tag each spell in the database with <spellType: Attack> (or Barrier, etc.)
// Chi is a brawler ability type, listed under Magic Skills for SP purposes.
TDarn.SPELL_TYPES = ["Attack", "Barrier", "Detect", "Levitate", "PlaneShift",
                     "Regenerate", "Shield", "Stasis", "Telepathy", "Trace", "Chi"];

TDarn.getMagicSkillNames = function() {
    return TDarn.SPELL_TYPES.slice();
};

// ── Add Skills command to main menu ───────────────────────────────────────

var _Window_MenuCommand_addOriginalCommands_skills = Window_MenuCommand.prototype.addOriginalCommands;
Window_MenuCommand.prototype.addOriginalCommands = function() {
    _Window_MenuCommand_addOriginalCommands_skills.call(this);
    this.addCommand("Skills & SP", "tdarnSkills", true);
};

var _Scene_Menu_createCommandWindow_skills = Scene_Menu.prototype.createCommandWindow;
Scene_Menu.prototype.createCommandWindow = function() {
    _Scene_Menu_createCommandWindow_skills.call(this);
    this._commandWindow.setHandler("tdarnSkills", this.commandTDarnSkills.bind(this));
};

Scene_Menu.prototype.commandTDarnSkills = function() {
    SceneManager.push(Scene_TDarnSkills);
};

//=============================================================================
// Scene_TDarnSkills
//
// Layout (816x624):
//   [Actor panel 180px] [Section list 200px] [Skill list 436px]
//   Help bar at top (2 lines)
//   Stat panel replaces skill list when no skill selected
//=============================================================================

function Scene_TDarnSkills() {
    this.initialize.apply(this, arguments);
}
Scene_TDarnSkills.prototype = Object.create(Scene_MenuBase.prototype);
Scene_TDarnSkills.prototype.constructor = Scene_TDarnSkills;

Scene_TDarnSkills.prototype.initialize = function() {
    Scene_MenuBase.prototype.initialize.call(this);
    this._actorIndex   = 0;
    this._sectionIndex = 0;
};

Scene_TDarnSkills.prototype.create = function() {
    Scene_MenuBase.prototype.create.call(this);
    this.createHelpWindow();
    this.createActorWindow();
    this.createSectionWindow();
    this.createSkillListWindow();
    this.createStatWindow();
    this._actorWindow.activate();
};

Scene_TDarnSkills.prototype.createHelpWindow = function() {
    this._helpWindow = new Window_Help(2);
    this._helpWindow.setText("Choose a character, then a category, then a skill to spend SP.");
    this.addWindow(this._helpWindow);
};

Scene_TDarnSkills.prototype.helpH = function() {
    return this._helpWindow.height;
};

Scene_TDarnSkills.prototype.createActorWindow = function() {
    var wy = this.helpH();
    this._actorWindow = new Window_TDarnActorSelect(0, wy, 180, Graphics.boxHeight - wy);
    this._actorWindow.setHandler("ok",     this.onActorOk.bind(this));
    this._actorWindow.setHandler("cancel", this.popScene.bind(this));
    this.addWindow(this._actorWindow);
};

Scene_TDarnSkills.prototype.createSectionWindow = function() {
    var wy = this.helpH();
    this._sectionWindow = new Window_TDarnSectionList(180, wy, 200, Graphics.boxHeight - wy);
    this._sectionWindow.setHandler("ok",     this.onSectionOk.bind(this));
    this._sectionWindow.setHandler("cancel", this.onSectionCancel.bind(this));
    this.addWindow(this._sectionWindow);
    this._sectionWindow.deactivate();
};

Scene_TDarnSkills.prototype.createSkillListWindow = function() {
    var wy = this.helpH();
    this._skillListWindow = new Window_TDarnSkillList2(380, wy, Graphics.boxWidth - 380, Graphics.boxHeight - wy);
    this._skillListWindow.setHandler("ok",     this.onSkillOk.bind(this));
    this._skillListWindow.setHandler("cancel", this.onSkillListCancel.bind(this));
    this.addWindow(this._skillListWindow);
    this._skillListWindow.deactivate();
    this._skillListWindow.hide();
};

Scene_TDarnSkills.prototype.createStatWindow = function() {
    var wy = this.helpH();
    this._statWindow = new Window_TDarnStats(380, wy, Graphics.boxWidth - 380, Graphics.boxHeight - wy);
    this.addWindow(this._statWindow);
};

Scene_TDarnSkills.prototype.currentActor = function() {
    return $gameParty.members()[this._actorIndex];
};

Scene_TDarnSkills.prototype.refreshAll = function() {
    var actor = this.currentActor();
    this._sectionWindow.setActor(actor);
    this._statWindow.setActor(actor);
    this._actorWindow.refresh();
};

// Actor selected → move to section list
Scene_TDarnSkills.prototype.onActorOk = function() {
    this._actorIndex = this._actorWindow.index();
    this.refreshAll();
    this._actorWindow.deactivate();
    this._sectionWindow.activate();
    this._sectionWindow.select(0);
    this._helpWindow.setText("Choose a skill category. Z/Enter to browse skills.");
};

// Section selected → show skill list
Scene_TDarnSkills.prototype.onSectionOk = function() {
    this._sectionIndex = this._sectionWindow.index();
    var section = this._sectionWindow.currentSection();
    var actor   = this.currentActor();
    this._skillListWindow.setActorAndSection(actor, section);
    this._statWindow.hide();
    this._skillListWindow.show();
    this._skillListWindow.activate();
    this._skillListWindow.select(0);
    this._sectionWindow.deactivate();
    this._helpWindow.setText("Select a skill to view SP progress. Skills level up automatically through use.");
};

Scene_TDarnSkills.prototype.onSectionCancel = function() {
    this._sectionWindow.deactivate();
    this._skillListWindow.hide();
    this._statWindow.show();
    this._actorWindow.activate();
    this._helpWindow.setText("Choose a character, then a category, then a skill to spend SP.");
};

Scene_TDarnSkills.prototype.onSkillListCancel = function() {
    this._skillListWindow.hide();
    this._skillListWindow.deactivate();
    this._statWindow.show();
    this._sectionWindow.activate();
    this._helpWindow.setText("Choose a skill category. Z/Enter to browse skills.");
};

// Skills advance automatically through battle use — this menu is read-only.
// Selecting a skill shows its current SP progress in the help bar.
Scene_TDarnSkills.prototype.onSkillOk = function() {
    var actor     = this.currentActor();
    var skillName = this._skillListWindow.currentSkillName();
    if (!actor || !skillName) { this._skillListWindow.activate(); return; }

    var level  = actor.tdarnSkillLevel(skillName);
    var spAcc  = actor.tdarnSkillSp(skillName);
    var needed = actor.tdarnSkillSpNeeded(skillName);
    var msg;
    if (level >= 20) {
        msg = skillName + " — Level 20. Mastered!";
    } else {
        var pct = needed > 0 ? Math.floor(spAcc / needed * 100) : 0;
        msg = skillName + " — Level " + level + " | " + spAcc + "/" + needed + " SP (" + pct + "%) — use in battle to earn SP.";
    }
    this._helpWindow.setText(msg);
    this._skillListWindow.activate();
};

// ── Window_TDarnActorSelect ───────────────────────────────────────────────

function Window_TDarnActorSelect() {
    this.initialize.apply(this, arguments);
}
Window_TDarnActorSelect.prototype = Object.create(Window_Selectable.prototype);
Window_TDarnActorSelect.prototype.constructor = Window_TDarnActorSelect;

Window_TDarnActorSelect.prototype.initialize = function(x, y, w, h) {
    Window_Selectable.prototype.initialize.call(this, x, y, w, h);
    this.refresh();
    this.select(0);
};

Window_TDarnActorSelect.prototype.maxItems = function() {
    return $gameParty.members().length;
};

Window_TDarnActorSelect.prototype.itemHeight = function() {
    return 72;
};

Window_TDarnActorSelect.prototype.drawItem = function(index) {
    var actor = $gameParty.members()[index];
    if (!actor) return;
    var rect = this.itemRect(index);
    this.drawFace(actor.faceName(), actor.faceIndex(), rect.x + 2, rect.y + 4, 48, 60);
    this.contents.fontSize = 13;
    this.resetTextColor();
    this.drawText(actor.name(), rect.x + 56, rect.y + 6, rect.width - 60, "left");
    this.contents.fontSize = 11;
    this.contents.textColor = "rgba(180,255,180,0.9)";
    this.drawText("SP: " + (actor._tdarnSp || 0) + "/" + (actor._tdarnSpMax || 0), rect.x + 56, rect.y + 26, rect.width - 60, "left");
    var skMap   = actor._tdarnSkills || {};
    var trained = Object.keys(skMap).filter(function(k) { return skMap[k] > 0; }).length;
    var spMap   = actor._tdarnSkillSp || {};
    var pending = Object.keys(spMap).filter(function(k) { return spMap[k] > 0; }).length;
    this.contents.textColor = "rgba(255,220,100,0.8)";
    this.contents.fontSize  = 11;
    this.drawText(trained + " trained  " + pending + " gaining SP", rect.x + 56, rect.y + 44, rect.width - 60, "left");
    this.resetTextColor();
};

// ── Window_TDarnSectionList ───────────────────────────────────────────────

function Window_TDarnSectionList() {
    this.initialize.apply(this, arguments);
}
Window_TDarnSectionList.prototype = Object.create(Window_Selectable.prototype);
Window_TDarnSectionList.prototype.constructor = Window_TDarnSectionList;

Window_TDarnSectionList.SECTIONS = [
    { name: "Weapon Skills",    icon: 97,  key: "weapon"  },
    { name: "Magic Skills",     icon: 79,  key: "magic"   },
    { name: "Character Skills", icon: 84,  key: "char"    }
];

Window_TDarnSectionList.prototype.initialize = function(x, y, w, h) {
    this._actor = null;
    Window_Selectable.prototype.initialize.call(this, x, y, w, h);
    this.refresh();
    this.select(0);
};

Window_TDarnSectionList.prototype.setActor = function(actor) {
    this._actor = actor;
    this.refresh();
};

Window_TDarnSectionList.prototype.maxItems = function() {
    return Window_TDarnSectionList.SECTIONS.length;
};

Window_TDarnSectionList.prototype.itemHeight = function() {
    return 60;
};

Window_TDarnSectionList.prototype.currentSection = function() {
    return Window_TDarnSectionList.SECTIONS[this.index()];
};

Window_TDarnSectionList.prototype.drawItem = function(index) {
    if (!Window_TDarnSectionList.SECTIONS[index]) return;
    var section = Window_TDarnSectionList.SECTIONS[index];
    var rect    = this.itemRect(index);
    this.drawIcon(section.icon, rect.x + 4, rect.y + 8);
    this.contents.fontSize = 15;
    this.resetTextColor();
    this.drawText(section.name, rect.x + 40, rect.y + 6, rect.width - 44, "left");
    if (this._actor) {
        var names   = this._sectionSkillNames(section.key);
        var epMap   = this._actor._tdarnSkillSp || {};
        var skMap   = this._actor._tdarnSkills  || {};
        var trained = 0;
        var hasEp   = 0;
        names.forEach(function(n) {
            if (skMap[n] && skMap[n] > 0) trained++;
            if (epMap[n] && epMap[n] > 0) hasEp++;
        });
        this.contents.fontSize = 11;
        this.contents.textColor = "rgba(200,220,255,0.75)";
        this.drawText(trained + " trained" + (hasEp ? "  +" + hasEp + " SP" : ""), rect.x + 40, rect.y + 32, rect.width - 44, "left");
        this.resetTextColor();
    }
};

Window_TDarnSectionList.prototype._sectionSkillNames = function(key) {
    if (key === "weapon")  return TDarn.getWeaponSkillNames();
    if (key === "magic")   return TDarn.getMagicSkillNames();
    if (key === "char")    return TDarn.CHAR_SKILLS;
    return [];
};

// ── Window_TDarnSkillList2 — skill detail list within a section ───────────

function Window_TDarnSkillList2() {
    this.initialize.apply(this, arguments);
}
Window_TDarnSkillList2.prototype = Object.create(Window_Selectable.prototype);
Window_TDarnSkillList2.prototype.constructor = Window_TDarnSkillList2;

Window_TDarnSkillList2.prototype.initialize = function(x, y, w, h) {
    this._actor   = null;
    this._section = null;
    this._list    = [];  // must exist before initialize calls maxItems
    Window_Selectable.prototype.initialize.call(this, x, y, w, h);
};

Window_TDarnSkillList2.prototype.setActorAndSection = function(actor, section) {
    this._actor   = actor;
    this._section = section;
    this._buildList();
    this.refresh();
    this.select(0);
};

Window_TDarnSkillList2.prototype._buildList = function() {
    if (!this._section) { this._list = []; return; }
    var key = this._section.key;
    if (key === "weapon")  this._list = TDarn.getWeaponSkillNames();
    else if (key === "magic")   this._list = TDarn.getMagicSkillNames();
    else if (key === "char")    this._list = TDarn.CHAR_SKILLS.slice();
    else this._list = [];

    // Append any earned skills that belong to this section but aren't listed yet.
    // Classification: weapon = in weaponType list or "Unarmed"
    //                 magic  = in SPELL_TYPES list
    //                 char   = everything else
    if (this._actor) {
        var epMap      = this._actor._tdarnSkillSp || {};
        var skMap      = this._actor._tdarnSkills  || {};
        var allNames   = Object.keys(epMap).concat(Object.keys(skMap));
        var weaponList = TDarn.getWeaponSkillNames();
        var magicList  = TDarn.getMagicSkillNames();
        var self       = this;
        allNames.forEach(function(n) {
            if (self._list.indexOf(n) !== -1) return;  // already listed
            var isWeapon = weaponList.indexOf(n) !== -1;
            var isMagic  = magicList.indexOf(n)  !== -1;
            var isChar   = !isWeapon && !isMagic;
            if (key === 'weapon' && isWeapon) self._list.push(n);
            if (key === 'magic'  && isMagic)  self._list.push(n);
            if (key === 'char'   && isChar)   self._list.push(n);
        });
    }
};

Window_TDarnSkillList2.prototype.maxItems = function() {
    return this._list ? this._list.length : 0;
};

Window_TDarnSkillList2.prototype.itemHeight = function() {
    return 44;
};

Window_TDarnSkillList2.prototype.currentSkillName = function() {
    return this._list[this.index()];
};

// Weapon type icon IDs from MV's default iconset (adjust as needed)
Window_TDarnSkillList2.WEAPON_ICONS = {
    "Unarmed":   78,
    "Sword":     97,
    "Axe":       101,
    "Bludgeon":  100,
    "Spear":     99,
    "Knife":     98,
    "Firearms":  116,
    "Gun":       116,
    "Bow":       104,
    "Thrown":    105
};

Window_TDarnSkillList2.prototype.drawItem = function(index) {
    if (!this._actor || !this._list || !this._list[index]) return;
    var skillName = this._list[index];
    var level     = this._actor.tdarnSkillLevel(skillName);
    var epAcc     = this._actor.tdarnSkillSp(skillName);
    var needed    = this._actor.tdarnSkillSpNeeded(skillName);
    var rect      = this.itemRect(index);

    // Icon (weapon section only; magic/char use generic icon)
    var iconId = Window_TDarnSkillList2.WEAPON_ICONS[skillName] || 79;
    if (this._section && this._section.key === "char") iconId = 84;
    this.drawIcon(iconId, rect.x + 2, rect.y + 4);

    // Skill name + level badge
    this.contents.fontSize = 14;
    this.resetTextColor();
    this.drawText(skillName, rect.x + 36, rect.y + 2, 130, "left");

    // Level as number
    this.contents.fontSize = 12;
    this.contents.textColor = level > 0 ? "rgba(255,200,50,0.95)" : "rgba(140,140,160,0.7)";
    this.drawText("Lv " + level, rect.x + 36, rect.y + 22, 50, "left");

    // Pip bar (10 wide pips instead of 20 narrow — fits in the panel)
    var pipX = rect.x + 90;
    var pipY = rect.y + 24;
    for (var i = 0; i < 20; i++) {
        var filled = i < level;
        var color  = filled ? "rgba(255,200,50,0.9)" : "rgba(50,50,70,0.7)";
        this.contents.fillRect(pipX + i * 10, pipY, 8, 10, color);
    }

    // SP progress: fraction + percentage
    var cw = this.contentsWidth();
    if (needed === Infinity) {
        this.contents.fontSize = 14;
        this.contents.textColor = "rgba(100,255,140,0.95)";
        this.drawText("MASTERED", cw - 90, rect.y + 4, 86, "right");
    } else {
        var pct = needed > 0 ? Math.floor(epAcc / needed * 100) : 0;
        this.contents.fontSize = 15;
        this.contents.textColor = "rgba(200,230,255,0.95)";
        this.drawText(epAcc + " / " + needed, cw - 104, rect.y + 2, 100, "right");
        this.contents.fontSize = 11;
        this.contents.textColor = pct >= 100 ? "rgba(100,255,120,0.9)" : "rgba(160,160,180,0.65)";
        this.drawText(pct + "%  to next level", cw - 104, rect.y + 22, 100, "right");
    }
    this.resetTextColor();
};

// ── Window_TDarnStats (stat block shown before section is chosen) ──────────

function Window_TDarnStats() {
    this.initialize.apply(this, arguments);
}
Window_TDarnStats.prototype = Object.create(Window_Base.prototype);
Window_TDarnStats.prototype.constructor = Window_TDarnStats;

Window_TDarnStats.prototype.initialize = function(x, y, w, h) {
    Window_Base.prototype.initialize.call(this, x, y, w, h);
    this._actor = null;
};

Window_TDarnStats.prototype.setActor = function(actor) {
    this._actor = actor;
    this.refresh();
};

Window_TDarnStats.prototype.refresh = function() {
    this.contents.clear();
    if (!this._actor) return;
    var a  = this._actor;
    var lh = 32;
    var y  = 0;

    var pow = a.tdarnPow ? a.tdarnPow() : (a.powerLevel ? a.powerLevel() : 0);
    var stats = [
        ["BOD",    a.tdarnBod(),    "Wound Pts: " + (a.tdarnBod() * 2) + "  Load: " + (a.tdarnBod() * 3) + " lb"],
        ["AGI",    a.tdarnAgi(),    "Initiative & combat rolls"],
        ["INT",    a.tdarnInt(),    "Intelligence / Spellpower"],
        ["POW",    pow,             "Spell power bonus (added to cast level)"],
        ["WILL",   a.tdarnWill(),   "SP pool base"],
        ["AWARE",  a.tdarnAware(),  "Perception & notice"],
        ["SOCIAL", a.tdarnSocial(), "Cash: $" + (a.tdarnSocial() * 100)]
    ];

    this.contents.fontSize = 13;
    for (var i = 0; i < stats.length; i++) {
        this.contents.textColor = "rgba(255,220,100,0.9)";
        this.drawText(stats[i][0], 4, y, 62, "left");
        this.contents.textColor = "#ffffff";
        this.drawText(stats[i][1], 70, y, 34, "right");
        this.contents.textColor = "rgba(180,200,220,0.7)";
        this.drawText(stats[i][2], 4, y + 15, this.contents.width - 8, "left");
        y += lh;
    }

    // Divider
    this.contents.fillRect(4, y + 4, this.contents.width - 8, 1, "rgba(255,255,255,0.15)");
    y += 14;
    this.contents.fontSize  = 11;
    this.contents.textColor = "rgba(160,200,180,0.7)";
    this.drawText("SP auto-awarded through battle use.", 4, y, this.contents.width - 8, "left");
    y += 16;
    var seMax = a.spellEnergyMax ? a.spellEnergyMax() : 0;
    if (seMax > 0) {
        var se = a.spellEnergy ? a.spellEnergy() : 0;
        this.contents.textColor = "rgba(160,200,255,0.9)";
        this.contents.fontSize  = 13;
        this.drawText("Spell Energy: " + se + " / " + seMax, 4, y, this.contents.width - 8, "left");
    }
};


console.log('T-Darn Combat System loaded successfully!');

})();