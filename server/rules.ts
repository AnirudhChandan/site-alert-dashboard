// The 7 rules from the client's requirements sheet, plus 'person_seen' (the raw checkpoint
// signal that feeds the patrol timers) and 'unknown' (an AI Box event we couldn't map).
export const SEVERITY = {
  slip_fall:      'critical',
  intrusion:      'critical',
  post_unmanned:  'high',
  patrol_missed:  'high',
  ppe_missing:    'medium',
  car_driveway:   'medium',
  animal:         'medium',
  person_seen:    'info',
  unknown:        'info',
} as const

export type Rule = keyof typeof SEVERITY

export const LABEL: Record<Rule, string> = {
  slip_fall:     'Resident Fall',
  intrusion:     'Periphery Intrusion',
  post_unmanned: 'Guard Absent From Post',
  patrol_missed: 'Patrol Not Done',
  ppe_missing:   'Labour Without PPE',
  car_driveway:  'Car Parked On Driveway',
  animal:        'Animal Detected',
  person_seen:   'Checkpoint Visited',
  unknown:       'Unmapped Event',
}

// The AI Box's exact rule strings are unknown until a real payload arrives.
// Match on keywords so a firmware wording change or a
// slightly different app name still lands on the right rule instead of dropping.
// Rule names seen on the CORTROL screen on site, 11 Sep 2026: Intrusion, Car Parking
// on Driveway, Stopping, Labour Movement, Animal Detection, Fallen Person,
// Security Available, Security Person absent, Wrong Way. First match wins, so
// "absent" is checked before "person" and "fall" before "person".
const KEYWORDS: [RegExp, Rule][] = [
  [/absent|unmanned|no.?guard/i,                'post_unmanned'],
  [/fall|fallen|slip|trip/i,                    'slip_fall'],
  [/helmet|vest|ppe|safety|labou?r/i,           'ppe_missing'],
  [/park|stop|stay.?&?.?go|vehicle|car\b/i,     'car_driveway'],
  [/animal|dog|cattle|monkey/i,                 'animal'],
  [/available|present|patrol|checkpoint/i,      'person_seen'],
  [/intrus|fence|climb|jump|loiter|perimeter/i, 'intrusion'],
  [/person|human|people|occupan/i,              'intrusion'],
]

export function ruleFrom(text: string): Rule {
  for (const [re, rule] of KEYWORDS) if (re.test(text)) return rule
  return 'unknown'
}

// Spoken/short Hindi labels for the voice announcement and the TV view.
export const LABEL_HI: Record<Rule, string> = {
  slip_fall:     'कोई व्यक्ति गिर गया है',
  intrusion:     'सीमा में घुसपैठ',
  post_unmanned: 'गार्ड पोस्ट पर नहीं है',
  patrol_missed: 'गश्त नहीं हुई',
  ppe_missing:   'मज़दूर बिना हेलमेट',
  car_driveway:  'ड्राइववे पर गाड़ी खड़ी है',
  animal:        'जानवर दिखा है',
  person_seen:   'चेकपॉइंट पर गार्ड',
  unknown:       'अज्ञात सूचना',
}

/**
 * One-tap reasons, picked right after marking an alert. "All fine" asks why it was
 * nothing; "Real problem" asks what was done. The code is stored; labels can change.
 * `only` limits a reason to the alert types it makes sense for; without it, it fits all.
 */
export type Reason = { code: string; outcome: 'false_alarm' | 'action_taken'; en: string; hi: string; only?: Rule[] }
const CHECKPOINT_RULES: Rule[] = ['post_unmanned', 'patrol_missed']
const PEOPLE_RULES: Rule[] = ['intrusion', 'car_driveway', 'ppe_missing', 'slip_fall', 'unknown']
export const REASONS: Reason[] = [
  { code: 'resident',   outcome: 'false_alarm',  en: 'Resident',                      hi: 'निवासी',                           only: PEOPLE_RULES },
  { code: 'visitor',    outcome: 'false_alarm',  en: 'Visitor',                       hi: 'मेहमान',                           only: PEOPLE_RULES },
  { code: 'staff',      outcome: 'false_alarm',  en: 'Staff or worker',               hi: 'स्टाफ़ या कर्मचारी',                 only: PEOPLE_RULES },
  { code: 'delivery',   outcome: 'false_alarm',  en: 'Delivery',                      hi: 'डिलीवरी',                          only: ['intrusion', 'car_driveway', 'unknown'] },
  { code: 'pet',        outcome: 'false_alarm',  en: 'Pet or known animal',           hi: 'पालतू या जाना-पहचाना जानवर',          only: ['animal'] },
  { code: 'ppe_ok',     outcome: 'false_alarm',  en: 'Was wearing safety gear',       hi: 'सुरक्षा उपकरण पहने थे',              only: ['ppe_missing'] },
  { code: 'on_round',   outcome: 'false_alarm',  en: 'Guard was on a round',          hi: 'गार्ड गश्त पर था',                   only: CHECKPOINT_RULES },
  { code: 'shadow',     outcome: 'false_alarm',  en: 'Shadow, light or rain',         hi: 'परछाईं, रोशनी या बारिश' },
  { code: 'camera',     outcome: 'false_alarm',  en: 'Camera mistake',                hi: 'कैमरे की गलती' },
  { code: 'went',       outcome: 'action_taken', en: 'Guard went there',              hi: 'गार्ड मौके पर गया' },
  { code: 'chased',     outcome: 'action_taken', en: 'Animal chased away',            hi: 'जानवर भगाया',                       only: ['animal'] },
  { code: 'moved',      outcome: 'action_taken', en: 'Vehicle moved',                 hi: 'गाड़ी हटवाई',                        only: ['car_driveway'] },
  { code: 'gear',       outcome: 'action_taken', en: 'Told to wear safety gear',      hi: 'सुरक्षा उपकरण पहनवाए',               only: ['ppe_missing'] },
  { code: 'stopped',    outcome: 'action_taken', en: 'Person stopped or sent out',    hi: 'व्यक्ति को रोका या बाहर भेजा',          only: ['intrusion', 'unknown'] },
  { code: 'helped',     outcome: 'action_taken', en: 'Person helped',                 hi: 'व्यक्ति की मदद की',                   only: ['slip_fall'] },
  { code: 'back',       outcome: 'action_taken', en: 'Guard back at post',            hi: 'गार्ड पोस्ट पर लौटा',                  only: CHECKPOINT_RULES },
  { code: 'supervisor', outcome: 'action_taken', en: 'Supervisor told',               hi: 'सुपरवाइज़र को बताया' },
  { code: 'emergency',  outcome: 'action_taken', en: 'Ambulance or police called',    hi: 'एम्बुलेंस या पुलिस बुलाई',             only: ['slip_fall', 'intrusion'] },
]
export const REASON = Object.fromEntries(REASONS.map(r => [r.code, r])) as Record<string, Reason>
export const reasonFits = (code: unknown, rule: string, outcome: string) => {
  const r = REASON[String(code)]
  return !!r && r.outcome === outcome && (!r.only || r.only.includes(rule as Rule))
}
