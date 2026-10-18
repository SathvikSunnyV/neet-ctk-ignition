// question_corrections.js
// ---------------------------------------------------------------------------
// Corrections and hygiene for the imported Bridge Course question bank
// (real_imported_questions.js).
//
// WHY THIS EXISTS
// The imported bank contained rows whose answer key did not match the
// question: explanations that reason their way to a different answer than the
// keyed option ("Hmm...", "Answer: b" while the key says D), questions with no
// correct option offered, "Both (a) and (b)" options that point at letters that
// moved when the options were rebalanced, duplicated options, and 80-character
// "-----" separators leaking into explanations shown to students.
//
// HOW IT WORKS
// - FIXES is a hand-reviewed list. Each entry finds its rows by question stem
//   (`prefix`), optionally disambiguated by `has` (an option text), because the
//   same stem is reused by different questions in a few places.
// - A fix may rewrite the stem (`q`), replace all four options (`options`) or
//   patch individual option texts (`sub`), and always names the correct option
//   by its TEXT (`correct`), so it works for every copy of the question no
//   matter how its options were ordered (NEET/JEE twins, Botany/Zoology twins).
// - applyCorrections() is a pure function: raw rows in, corrected rows out
//   (same length, same order). db.js uses the same raw/corrected pair to repair
//   databases that were already seeded with the old data, touching only rows
//   that still equal the old imported values (so faculty edits are never
//   overwritten).
// ---------------------------------------------------------------------------

// ---- generic hygiene -------------------------------------------------------
function cleanExplanation(e) {
    if (e === null || e === undefined) return e;
    const s = String(e)
        .replace(/\s*[=\-]{10,}\s*/g, ' ')                 // "-----" / "=====" separators
        .replace(/^\s*Explanation:\s*/i, '')               // redundant prefix (UI already labels it)
        .replace(/\s+(EASY|MODERATE|DIFFICULT)\s*$/, '')   // leaked difficulty tag
        .replace(/\s+/g, ' ')
        .trim();
    return s === '' ? null : s;
}

function cleanOption(t) {
    const s = String(t);
    // stray closing bracket left over from an editing slip, e.g. "9 m/s²]"
    if (/[\]\}]\s*$/.test(s) && !/[\[\{]/.test(s)) return s.replace(/[\]\}]\s*$/, '').trim();
    return s.trim();
}

// ---- hand-reviewed fixes ---------------------------------------------------
// Convention: `correct` is the exact text of the correct option AFTER `sub` /
// `options` are applied.
const FIXES = [
    // ===================== CHEMISTRY =====================
    { prefix: 'The velocity of light in vacuum is approximately',
      options: ['3 × 10⁸ m/s', '3 × 10⁸ km/s', '3 × 10⁸ cm/s', '3 × 10⁶ m/s'], correct: '3 × 10⁸ m/s',
      exp: 'c ≈ 3 × 10⁸ m/s (equivalently 3 × 10¹⁰ cm/s or 3 × 10⁵ km/s).' },
    { prefix: 'The value of Rydberg constant (R) is',
      options: ['1.097 × 10⁷ m⁻¹', '1.097 × 10⁵ m⁻¹', '1.097 × 10⁹ m⁻¹', '1.097 × 10³ m⁻¹'], correct: '1.097 × 10⁷ m⁻¹',
      exp: 'R = 1.097 × 10⁷ m⁻¹ (which is the same as 1.097 × 10⁵ cm⁻¹).' },
    { prefix: 'The mass of a proton is approximately',
      options: ['1.67 × 10⁻²⁷ kg', '9.11 × 10⁻³¹ kg', '1.67 × 10⁻³¹ kg', '1.67 × 10⁻²⁴ kg'], correct: '1.67 × 10⁻²⁷ kg',
      exp: 'Proton mass = 1.67 × 10⁻²⁷ kg (= 1.67 × 10⁻²⁴ g). 9.11 × 10⁻³¹ kg is the electron mass.' },
    { prefix: 'The first ionisation enthalpy of aluminium is lower than that of magnesium because',
      options: ['Al has a higher atomic radius than Mg',
                "Al's outermost electron is in a 3p orbital, while Mg has a stable, completely filled 3s² configuration",
                'Al has a lower nuclear charge than Mg',
                'Mg has a half-filled 3p subshell'],
      correct: "Al's outermost electron is in a 3p orbital, while Mg has a stable, completely filled 3s² configuration",
      exp: 'The 3p electron of Al is higher in energy and better shielded than the 3s electron of Mg, and Mg’s 3s² is a stable filled subshell, so Al loses its outer electron more easily. Al is actually smaller and has the higher nuclear charge.' },
    { prefix: 'The hybridisation of central atom in I₃⁺',
      correct: 'sp³',
      exp: 'Central I in I₃⁺ has 2 bond pairs and 2 lone pairs = 4 electron pairs, so it is sp³ (bent). The sp³d case is I₃⁻.' },
    { prefix: 'Which of the following has the highest third ionisation enthalpy?',
      correct: 'Mg',
      exp: 'IE₃ of Mg removes an electron from the stable neon-like Mg²⁺ core (≈ 7733 kJ/mol), higher than Na (≈ 6910), Si (≈ 3231) and Al (≈ 2745).' },
    { prefix: 'Which of the following pairs have the same geometry but different hybridisation?',
      q: 'Which of the following pairs has the same geometry and the same hybridisation of the central atom?',
      options: ['XeF₄ and ICl₄⁻', 'NH₃ and BF₃', 'SF₄ and ClF₃', 'CH₄ and XeF₄'], correct: 'XeF₄ and ICl₄⁻',
      exp: 'XeF₄ and ICl₄⁻ are both square planar with sp³d² central atoms. NH₃ is pyramidal (sp³) and BF₃ planar (sp²); SF₄ is see-saw while ClF₃ is T-shaped; CH₄ is tetrahedral (sp³) while XeF₄ is square planar (sp³d²).' },
    { prefix: 'The number of sigma bonds in P₄O₁₀ is',
      correct: '16',
      exp: 'P₄O₁₀ has 12 bridging P–O σ bonds and 4 terminal P=O bonds, each contributing one σ bond: 12 + 4 = 16 σ bonds.' },
    { prefix: 'Which of the following has the highest dipole moment?', has: 'HI',
      correct: 'HF',
      exp: 'Dipole moment follows the electronegativity difference: HF (≈ 1.9 D) > HCl > HBr > HI.' },
    { prefix: 'The number of antibonding electrons in N₂⁺ is',
      correct: '4',
      exp: 'N₂⁺ (13 electrons): σ1s² σ*1s² σ2s² σ*2s² π2p⁴ σ2p¹. The antibonding electrons are σ*1s² and σ*2s², i.e. 4.' },
    { prefix: 'The number of sigma and pi bonds in but-1-ene-3-yne',
      sub: [['8σ, 3π', '7σ, 3π']], correct: '7σ, 3π',
      exp: 'HC≡C–CH=CH₂: σ bonds = 3 C–C + 4 C–H = 7; π bonds = 2 (triple bond) + 1 (double bond) = 3.' },
    { prefix: 'The electronegativity of an element is 2.5.',
      sub: [['Group 14, period 3', 'Group 14, period 2']], correct: 'Group 14, period 2',
      exp: 'Carbon (group 14, period 2) has a Pauling electronegativity of ≈ 2.5. Silicon, in period 3, is only 1.9.' },
    { prefix: 'The correct order of electron gain enthalpy for the following is:',
      sub: [['S > Se > O > Te', 'S > Se > Te > O']], correct: 'S > Se > Te > O',
      exp: 'Electron gain enthalpy (magnitude): S (−200) > Se (−195) > Te (−190) > O (−141 kJ/mol). Oxygen is lower because of strong repulsion in its small 2p subshell.' },
    { prefix: 'Which of the following statements is incorrect?', has: 'Atomic radius of Ga is greater than Al',
      correct: 'Atomic radius of Ga is greater than Al',
      exp: 'Ga (135 pm) is slightly smaller than Al (143 pm) because the 3d electrons shield the nucleus poorly. The other three statements are true.' },
    { prefix: 'The number of nodal planes in π* antibonding orbital is',
      correct: '2',
      exp: 'A π* orbital has two nodal planes: one containing the internuclear axis and one perpendicular to it between the nuclei.' },
    { prefix: 'The ionisation energy of He⁺ is 54.4 eV.',
      options: ['122.4 eV', '30.6 eV', '13.6 eV', '27.2 eV'], correct: '122.4 eV',
      exp: 'IE ∝ Z². For Li²⁺ (Z = 3): 13.6 × 9 = 122.4 eV.' },
    { prefix: 'The correct order of penetrating power of orbitals is',
      options: ['1s > 2s > 2p > 3s', '1s > 2s > 3s > 2p', '3s > 2p > 2s > 1s', '2p > 2s > 1s > 3s'], correct: '1s > 2s > 2p > 3s',
      exp: 'Penetration decreases with increasing n, and within a shell follows s > p > d: 1s > 2s > 2p > 3s.' },
    { prefix: 'The uncertainty in position of an electron (mass 9.1×10⁻³¹ kg)',
      correct: '1.93 × 10⁻⁵ m',
      exp: 'Δv = 0.01% of 3 × 10⁴ = 3 m/s. Δx ≥ h/(4π m Δv) = 6.626 × 10⁻³⁴ / (4π × 9.1 × 10⁻³¹ × 3) ≈ 1.93 × 10⁻⁵ m.' },
    { prefix: 'Which of the following has the smallest atomic radius?', has: 'P',
      correct: 'Cl',
      exp: 'Across period 3 the covalent radius shrinks: P (110 pm) > S (104 pm) > Cl (99 pm). Ar is not bonded, so its radius is not comparable and is much larger on the van der Waals scale.' },
    { prefix: 'The number of sigma bonds in ethyne',
      correct: '3',
      exp: 'H–C≡C–H has two C–H σ bonds and one C–C σ bond (the triple bond adds two π bonds): 3 σ bonds.' },
    { prefix: 'The formal charge on oxygen in ozone',
      correct: '+1',
      exp: 'In the Lewis structure O=O⁺–O⁻, the central oxygen has 3 bonds and 1 lone pair: formal charge = 6 − 2 − 3 = +1.' },
    { prefix: 'The wave number of the first line of Balmer series',
      correct: '1.523 × 10⁶ m⁻¹',
      exp: 'ν̄ = R(1/2² − 1/3²) = 1.097 × 10⁷ × 5/36 ≈ 1.523 × 10⁶ m⁻¹.' },

    // ===================== PHYSICS =====================
    { prefix: 'A 10 kg hanging mass and 20 kg mass on smooth incline',
      correct: '0',
      exp: 'Pull of the hanging mass = 10 × 10 = 100 N. Component of the 20 kg block along the incline = 20 × 10 × sin30° = 100 N. The forces balance, so a = 0.' },
    { prefix: 'A 2 kg block on 30° incline (μₖ=0.3',
      sub: [['3.4 m/s²', '2.4 m/s²']], correct: '2.4 m/s²',
      exp: 'a = g(sinθ − μₖcosθ) = 10(0.5 − 0.3 × 0.866) ≈ 2.4 m/s².' },
    { prefix: 'A bullet (m=20g) penetrates board.',
      correct: '1.6 cm',
      exp: 'Work–energy: F·d = ½m(u² − v²) = ½(0.02)(300² − 100²) = 800 J, so d = 800 / 50000 = 0.016 m = 1.6 cm.' },
    { prefix: 'A bullet (20g) moving at 400 m/s embeds in 2kg block.',
      sub: [['3.92 m/s', '3.6 m/s']], correct: '4 m/s',
      exp: 'Momentum conservation: 0.02 × 400 = (2 + 0.02)v, so v = 8 / 2.02 ≈ 4 m/s.' },
    { prefix: 'Two blocks connected by string over pulley (3kg left',
      sub: [['37.5 N', '18.75 N']], correct: '18.75 N',
      exp: 'T = m₁m₂g / (m₁ + m₂) = 3 × 5 × 10 / 8 = 18.75 N.' },
    { prefix: 'Stone dropped from a tower; another thrown downward at 5 m/s 2 s later.',
      correct: 'Never',
      exp: 'Stone 1: y = 5t². Stone 2: y = 5(t−2)² + 5(t−2). Setting them equal gives t = 2/3 s, before the second stone is thrown. At t = 2 s stone 1 already has speed 20 m/s, faster than stone 2 (5 m/s), so the second stone never catches up.' },
    { prefix: 'Two masses connected by string over frictionless pulley. One on 30° frictionless incline',
      correct: 'System at rest',
      exp: 'Along the incline the 4 kg block pulls with 4 × 10 × sin30° = 20 N; the hanging 2 kg block pulls with 2 × 10 = 20 N. The net force is zero, so the system stays at rest.' },
    { prefix: 'An elastic ball bounces from floor.',
      sub: [['5.9 m', '3.5 m']], correct: '3.5 m',
      exp: 'h₅ = 10 × 0.81⁵ ≈ 3.49 m.' },
    { prefix: 'A pump (efficiency 80%) lifts 600 kg water',
      correct: '2.5 kW',
      exp: 'Output power = mgh/t = 600 × 10 × 20 / 60 = 2000 W. Input = 2000 / 0.8 = 2500 W = 2.5 kW.' },
    { prefix: 'Ball A (1kg, v=2m/s) collides with stationary B (2kg).',
      correct: 'v_A=0, v_B=1 m/s',
      exp: 'Momentum: v_A + 2v_B = 2. Restitution: v_B − v_A = 0.5 × 2 = 1. Solving: v_A = 0, v_B = 1 m/s.' },
    { prefix: 'Two equal masses moving at same speed in same direction collide perfectly inelastically.',
      correct: 'v',
      exp: 'Both bodies already move with the same velocity, so momentum conservation gives a common final speed of v.' },
    { prefix: 'A ball thrown from height h₁ above ground with speed u upward.',
      correct: '2u²/g',
      exp: 'The first ball returns to height h₁ after T = 2u/g. The second ball, dropped from rest, must fall h₂ in that time: h₂ = ½gT² = ½g(2u/g)² = 2u²/g.' },
    { prefix: 'A 5kg block is pushed along floor by 25N at 37° below horizontal',
      q: 'A 5 kg block is pushed along the floor by a 25 N force at 37° below the horizontal (μₖ = 0.2, g = 10, sin37° = 0.6). The kinetic friction force on the block is:',
      options: ['4.8 N', '10 N', '13 N', 'The block does not move'], correct: '13 N',
      exp: 'N = mg + F sin37° = 50 + 15 = 65 N, so f = μₖN = 0.2 × 65 = 13 N. The horizontal push is 25 cos37° = 20 N, so the block does move (a = 7/5 = 1.4 m/s²).' },
    { prefix: 'Stone dropped; another dropped 2 s later from same height.',
      sub: [['30 m', '40 m']], correct: '40 m',
      exp: 'After 3 s the first stone has fallen ½·10·3² = 45 m and the second ½·10·1² = 5 m, so they are 40 m apart.' },
    { prefix: 'Power delivered by force F=10t N to body of mass 5kg',
      sub: [['500 W', '1250 W']], correct: '1250 W',
      exp: 'a = F/m = 2t, so v = t². P = Fv = 10t · t² = 10t³. At t = 5 s: P = 1250 W.' },
    { prefix: 'Coefficient of friction between tyres and road=0.6.',
      sub: [['62.5 m', '52 m']], correct: '52 m',
      exp: 'v = 90 km/h = 25 m/s. s = v² / (2μg) = 625 / 12 ≈ 52 m.' },
    { prefix: 'A block (2kg) rests on another block (5kg) on frictionless floor.',
      sub: [['40 N', '28 N']], correct: '28 N',
      exp: 'The upper block can accelerate at most μg = 4 m/s² (friction-limited). For both to move together, F = (2 + 5) × 4 = 28 N.' },
    { prefix: 'Two objects (3kg, 2kg) moving at 4m/s and 3m/s toward each other.',
      sub: [['6 m/s', '5.4 m/s']], correct: '5.4 m/s',
      exp: 'For the lighter body: v₂′ = [2m₁v₁ + (m₂ − m₁)v₂] / (m₁ + m₂) = [2·3·4 + (2 − 3)(−3)] / 5 = 5.4 m/s. (The 3 kg body ends at −1.6 m/s.)' },
    { prefix: 'Three blocks (1,2,3 kg) on frictionless surface pulled by F=18N.',
      q: 'Three blocks (1 kg, 2 kg, 3 kg) in a row on a frictionless surface are pulled by F = 18 N. Tension between the 2 kg and 3 kg blocks:',
      correct: '9 N',
      exp: 'a = 18 / 6 = 3 m/s². The tension between the 2 kg and 3 kg blocks is 9 N (3 kg × 3 m/s², or equivalently (1 + 2) kg × 3 m/s² depending on which end F is applied).' },
    { prefix: 'Body moves 2m east, 6m north, 3m west.',
      correct: '√37 m',
      exp: 'Net displacement: 1 m west and 6 m north, so |d| = √(1² + 6²) = √37 m.' },
    { prefix: 'Coefficient of static friction between tyres and road=0.8.',
      sub: [['30 m/s', '31.6 m/s']], correct: '31.6 m/s',
      exp: 'v = √(μrg) = √(0.8 × 125 × 10) = √1000 ≈ 31.6 m/s.' },
    { prefix: 'Spring (k=1000 N/m, natural length 0.5m).',
      correct: '20J, 200N',
      exp: 'Extension x = 0.2 m. PE = ½kx² = ½ × 1000 × 0.04 = 20 J; F = kx = 200 N.' },
    { prefix: 'A car of 1200 kg moves at 72 km/h and brakes to stop in 50m.',
      correct: '4800 N',
      exp: 'v = 20 m/s. a = v²/2s = 400/100 = 4 m/s². F = ma = 1200 × 4 = 4800 N.' },
    { prefix: 'A block (10kg) on rough surface (μₛ=0.5',
      correct: 'Stationary',
      exp: 'N = mg − F sin37° = 100 − 24 = 76 N, so f_max = 0.5 × 76 = 38 N. The horizontal pull is 40 cos37° = 32 N < 38 N, so the block stays at rest.' },
    { prefix: 'Two masses (3kg, 1kg) in elastic head-on collision.',
      sub: [['v₁=2m/s, v₂=8m/s', 'v₁=2m/s, v₂=6m/s']], correct: 'v₁=2m/s, v₂=6m/s',
      exp: 'v₁′ = (3−1)/(3+1) × 4 = 2 m/s; v₂′ = 2×3/(3+1) × 4 = 6 m/s. (Check: relative speed 4 before, 4 after.)' },
    { prefix: 'A bullet (20g, 600m/s) embeds in 2kg block.',
      sub: [['3590 J', '≈ 3564 J']], correct: '≈ 3564 J',
      exp: 'Initial KE = ½(0.02)(600²) = 3600 J. Common speed v = 12 / 2.02 ≈ 5.94 m/s gives final KE ≈ 35.6 J. Heat = 3600 − 35.6 ≈ 3564 J.' },
    { prefix: 'Work done against friction to stop a 500kg car at 20m/s',
      correct: '100 kJ',
      exp: 'All the kinetic energy is dissipated by friction: ½ × 500 × 20² = 100,000 J = 100 kJ.' },
    { prefix: 'A block (m kg) on rough incline (angle θ). Required minimum force',
      options: ['mg sinθ/2', 'Zero, since μ already holds', 'mg sinθ', 'mg cosθ/2'], correct: 'mg sinθ/2',
      exp: 'With μ = tanθ/2, friction can supply only μmg cosθ = mg sinθ/2. The remaining mg sinθ/2 must be provided by the applied force.' },
    { prefix: 'A body thrown up from ground at 30 m/s. A target is at 20m height.',
      options: ['t = 0.5 s and t = 5.5 s', 't = 1 s and t = 5 s', 't = 2 s and t = 4 s', 't = 3 ± √5 s'], correct: 't = 3 ± √5 s',
      exp: '30t − 5t² = 20 → t² − 6t + 4 = 0 → t = 3 ± √5 ≈ 0.76 s and 5.24 s.' },
    // --- matching-type questions whose options were scrambled / had no valid key ---
    { prefix: 'Match the physical concept with its definition',
      q: 'Which of the following correctly matches a physical quantity with its definition?',
      options: ['Average velocity — total displacement ÷ total time', 'Speed — rate of change of velocity',
                'Instantaneous velocity — total distance ÷ total time', 'Acceleration — magnitude of velocity'],
      correct: 'Average velocity — total displacement ÷ total time',
      exp: 'Average velocity = total displacement / total time. Speed is the magnitude of velocity; acceleration is the rate of change of velocity.' },
    { prefix: 'Match power-related quantities',
      q: 'Which of the following pairs is correctly matched?',
      options: ['1 horsepower — 746 W', '1 kilowatt-hour — 746 W', 'Efficiency — F·v', '1 horsepower — 3.6 × 10⁶ J'],
      correct: '1 horsepower — 746 W',
      exp: '1 hp = 746 W; 1 kWh = 3.6 × 10⁶ J; efficiency = useful output / total input; instantaneous power = F·v.' },
    { prefix: 'Match energy types with expressions',
      q: 'Which of the following pairs is correctly matched?',
      options: ['Kinetic energy — ½mv²', 'Gravitational PE — −μmgd', 'Elastic PE — mgh', 'Work done by friction — F·v'],
      correct: 'Kinetic energy — ½mv²',
      exp: 'KE = ½mv², gravitational PE = mgh, elastic PE = ½kx², work by friction = −μmgd, power = F·v.' },
    { prefix: 'Match the type of motion with the shape of x-t graph',
      q: 'Which of the following correctly matches a type of motion with its x–t graph?',
      options: ['Body at rest — horizontal line', 'Uniform velocity — parabola',
                'Uniform acceleration from rest — straight line through the origin', 'Uniform velocity — sinusoidal curve'],
      correct: 'Body at rest — horizontal line',
      exp: 'Rest: horizontal line. Uniform velocity: straight line with constant slope. Uniform acceleration from rest: parabola. SHM: sinusoidal curve.' },
    { prefix: 'Match conservative/non-conservative forces with examples',
      q: 'Which of the following is correctly matched?',
      options: ['Friction — conservative force', 'Gravity — conservative force (path-independent work)',
                'Work-energy theorem — W_net = ΔPE', 'Spring force — non-conservative force'],
      correct: 'Gravity — conservative force (path-independent work)',
      exp: 'Gravity and spring forces are conservative; friction is not. The work–energy theorem is W_net = ΔKE.' },
    { prefix: 'Match the kinematic equation with its primary use',
      q: 'Which kinematic equation is used when the time is not given?',
      options: ['v = u + at', 's = ut + ½at²', 'v² = u² + 2as', 'sₙ = u + a(2n−1)/2'], correct: 'v² = u² + 2as',
      exp: 'v² = u² + 2as relates velocity and displacement without time.' },
    { prefix: 'Match the formula with the quantity it gives for a projectile',
      q: 'The maximum height H of a projectile (speed u, angle θ, gravity g) is:',
      options: ['u² sin2θ / g', 'u sinθ − gt', '2u sinθ / g', 'u² sin²θ / 2g'], correct: 'u² sin²θ / 2g',
      exp: 'H = u² sin²θ / 2g. The range is u² sin2θ/g and the time of flight is 2u sinθ/g.' },
    { prefix: 'Match the slope/area of kinematic graphs',
      q: 'Which of the following correctly matches a graph feature with the quantity it gives?',
      options: ['Slope of x–t graph — velocity', 'Area under v–t graph — acceleration',
                'Slope of v–t graph — displacement', 'Area under a–t graph — position'],
      correct: 'Slope of x–t graph — velocity',
      exp: 'x–t slope = velocity; v–t slope = acceleration; v–t area = displacement; a–t area = change in velocity.' },
    { prefix: 'Match energy situations with outcomes',
      q: 'Which of the following is correctly matched?',
      options: ['Spring stretched and released — elastic PE → KE', 'Pendulum at bottom — maximum PE, minimum KE',
                'Rocket expels gas — GPE → KE → electrical energy', 'Ball falls from h to ground — momentum conserved, chemical → KE'],
      correct: 'Spring stretched and released — elastic PE → KE',
      exp: 'A released spring converts elastic PE to KE. A pendulum has maximum KE and minimum PE at the bottom; a rocket converts chemical energy to KE; a falling ball converts GPE to KE.' },
    { prefix: 'Match collision types with properties',
      q: 'Which of the following is correctly matched?',
      options: ['Elastic collision — KE and momentum both conserved', 'Coefficient of restitution e = 0 — elastic collision',
                'Inelastic collision — KE and momentum both conserved', 'Perfectly inelastic collision — objects separate after impact'],
      correct: 'Elastic collision — KE and momentum both conserved',
      exp: 'Elastic: KE and momentum conserved (e = 1). Inelastic: only momentum conserved. Perfectly inelastic: objects stick together (e = 0).' },
    { prefix: 'A 5kg block is on top of 10kg block',
      q: 'A 5 kg block rests on a 10 kg block on a frictionless floor (μ between the blocks = 0.5, g = 10). The force F on the 10 kg block for it to slide out from under the 5 kg block must be:',
      options: ['25 N', '50 N', 'More than 75 N', '15 N'], correct: 'More than 75 N',
      exp: 'The 5 kg block can accelerate at most μg = 5 m/s², so the pair moves together up to F = (5 + 10) × 5 = 75 N. Sliding starts when F exceeds 75 N.' },
    { prefix: 'A block (μ=0.4) on surface. Applied force at 30° above horizontal',
      q: 'A 10 kg block is pulled by a force F = 40 N directed 30° above the horizontal on a rough surface (g = 10). The normal force on the block is:',
      options: ['100 N', '90 N', '80 N', '120 N'], correct: '80 N',
      exp: 'N = mg − F sin30° = 100 − 40 × 0.5 = 80 N.' },

    // ===================== BIOLOGY =====================
    { prefix: 'The number of mitochondria in a cell depends on',
      options: ['Age of the cell', 'Size of the cell', 'Functional activity of the cell', 'Thickness of the cell wall'],
      correct: 'Functional activity of the cell',
      exp: 'Cells with high energy demands (muscle, liver, sperm) contain many mitochondria, so the number tracks the cell’s functional activity.' }
];


// ---------------------------------------------------------------------------
function optionsOf(r) { return [r.option_a, r.option_b, r.option_c, r.option_d]; }

function matchesFix(row, fix) {
    if (!String(row.question_text).startsWith(fix.prefix)) return false;
    if (fix.has && !optionsOf(row).includes(fix.has)) return false;
    return true;
}

function applyFixToRow(row, fix) {
    let opts = optionsOf(row).map(cleanOption);
    if (fix.options) opts = fix.options.slice();
    else if (fix.sub) opts = opts.map(t => {
        for (const [from, to] of fix.sub) if (t === from) return to;
        return t;
    });
    const idxs = opts.map((t, i) => (t === fix.correct ? i : -1)).filter(i => i >= 0);
    if (idxs.length !== 1) {
        throw new Error(`question_corrections: fix "${fix.prefix}" — correct option "${fix.correct}" matched ${idxs.length} options in [${opts.join(' | ')}]`);
    }
    return {
        ...row,
        question_text: fix.q || row.question_text,
        option_a: opts[0], option_b: opts[1], option_c: opts[2], option_d: opts[3],
        correct_answer: 'ABCD'[idxs[0]],
        explanation: fix.exp
    };
}

/**
 * Apply FIXES + hygiene to raw rows. Pure; returns { rows, report }.
 * rows.length === raw.length and order is preserved.
 */
function applyCorrections(raw) {
    const hits = new Map(FIXES.map(f => [f, 0]));
    const rows = raw.map(row => {
        const fix = FIXES.find(f => matchesFix(row, f));
        if (fix) { hits.set(fix, hits.get(fix) + 1); return applyFixToRow(row, fix); }
        return {
            ...row,
            option_a: cleanOption(row.option_a), option_b: cleanOption(row.option_b),
            option_c: cleanOption(row.option_c), option_d: cleanOption(row.option_d),
            explanation: cleanExplanation(row.explanation)
        };
    });
    const unmatched = FIXES.filter(f => hits.get(f) === 0).map(f => f.prefix);
    return { rows, report: { fixes: FIXES.length, rowsFixed: [...hits.values()].reduce((a, b) => a + b, 0), unmatched } };
}

/** Rows whose stored values differ between raw and corrected: the DB-repair work list. */
function changedRows(raw, corrected) {
    const out = [];
    for (let i = 0; i < raw.length; i++) {
        const a = raw[i], b = corrected[i];
        if (a.question_text !== b.question_text || a.option_a !== b.option_a || a.option_b !== b.option_b ||
            a.option_c !== b.option_c || a.option_d !== b.option_d || a.correct_answer !== b.correct_answer ||
            (a.explanation ?? null) !== (b.explanation ?? null)) {
            out.push({ old: a, now: b });
        }
    }
    return out;
}

module.exports = { FIXES, applyCorrections, changedRows, cleanExplanation, cleanOption };