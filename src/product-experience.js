/**
 * Handwritten DOM adapter for source-projected Product.Experience declarations.
 * This reads existing runtime observations. It does not keep a second effect,
 * custody, publication or resource ledger, and is not a host certificate.
 */
import { model, MODEL_SOURCE } from './layer1-uor/generated-model.js';

const project = (name, ...args) => model[`Product.Experience.${name}`](...args);
export const operatorJourneys = Object.freeze(project('journeys'));
export const operatorActions = Object.freeze(project('actions'));
export const experienceProvenance = Object.freeze({
  source: 'app/src/Product/Experience.lex.tex',
  sourceSha256: MODEL_SOURCE.sources.find(s => s.path === 'app/src/Product/Experience.lex.tex').sha256,
  assurance: 'Project-owned source projection and handwritten DOM adapter; not whole-host certification',
});

export function experienceFacts(observations = {}) {
  // Reject undeclared or inexact observations through the same source evaluator.
  const facts = { ...project('initialFacts'), ...observations };
  project('actionAllowed', 15, facts);
  return facts;
}
export const experienceView = (journey, facts) => project(`${journey}View`, facts);
export const experienceActionAllowed = (control, facts) => {
  const action = operatorActions.find(a => a.control === control);
  return Boolean(action && project('actionAllowed', action.code, facts));
};
export const integrityLabel = verified => project('integrityLabel', verified);
export const executionLabel = replayed => project('executionLabel', replayed);

/** Native buttons retain Enter/Space semantics; navigation never changes the
 * mesh-key URL hash or browser history. Focus moves only on explicit navigation,
 * never on asynchronous status updates. Scrolling is nonanimated, including for
 * reduced-motion users. Model text always enters the DOM via textContent.
 */
export function createOperatorExperience({ document, snapshot, onRefused = () => {} }) {
  const get = id => document.getElementById(id);
  const styles = new Map(project('evidenceStyles').map(s => [s.id, s.color]));
  const facts = () => experienceFacts(snapshot());
  let selected = operatorJourneys[0].id;
  const previousViews = new Map();
  const nav = get('operatorJourneyNav');
  nav.setAttribute('aria-label', project('navigationLabel'));
  const buttons = new Map();
  function navigate(journey) {
    selected = journey.id;
    render();
    const target = get(journey.target);
    // Selected context is source-owned. Existing inputs and domain state are retained.
    if (project('focusNavigationTarget')) target.focus({ preventScroll: true });
    target.scrollIntoView({ behavior: project('navigationScrollBehavior'), block: 'start' });
  }
  nav.replaceChildren(...operatorJourneys.map(journey => {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'secondary';
    button.textContent = journey.title;
    button.setAttribute('aria-controls', journey.target);
    button.addEventListener('click', () => navigate(journey));
    buttons.set(journey.id, button);
    const target = get(journey.target);
    target.tabIndex = -1;
    target.setAttribute('aria-labelledby', `${journey.id}Title`);
    get(`${journey.id}Title`).textContent = journey.title;
    get(`${journey.id}ExplanationLabel`).textContent = project('explanationLabel');
    const evidence = get(`${journey.id}Evidence`);
    evidence.setAttribute('role', 'status');
    evidence.setAttribute('aria-live', project('statusLivePolicy'));
    evidence.setAttribute('aria-atomic', 'true');
    return button;
  }));
  get('reviewResourcePolicyBtn').textContent = project('recoveryPolicyLabel');
  get('reviewResourcePolicyBtn').addEventListener('click', () => navigate(operatorJourneys.find(j => j.id === 'resources')));
  get('productTitle').textContent = project('productTitle');
  get('meshDisclosureText').textContent = project('disclosureLabel');
  get('relayDisclosureText').textContent = project('relayLabel');
  get('experienceProvenance').textContent = project('provenanceLabel');
  get('experienceProvenance').setAttribute('data-model-source-sha256', experienceProvenance.sourceSha256);
  function render() {
    const observation = facts();
    for (const [index, journey] of operatorJourneys.entries()) {
      const view = experienceView(journey.id, observation);
      const evidence = get(`${journey.id}Evidence`);
      const text = `${view.title}. ${view.evidence}.`;
      get(journey.target).hidden = !project('journeyVisible', operatorJourneys.findIndex(j => j.id === selected), index);
      get(`${journey.id}Explanation`).textContent = view.detail;
      if (previousViews.get(journey.id) !== view.id) {
        get(`${journey.id}ExplanationPanel`).open = project('explanationInitiallyOpen', observation, index);
        previousViews.set(journey.id, view.id);
      }
      // Avoid repeating unchanged polite announcements on each scheduler tick.
      if (evidence.textContent !== text) evidence.textContent = text;
      evidence.setAttribute('data-experience-state', view.id);
      const tone = project('viewStyle', observation, index);
      evidence.setAttribute('data-evidence-style', tone);
      evidence.style.color = styles.get(tone);
      evidence.style.borderInlineStartColor = styles.get(tone);
      buttons.get(journey.id).setAttribute('aria-current', journey.id === selected ? 'location' : 'false');
      if (journey.id === selected) {
        get('operatorJourneySummary').textContent = journey.summary;
        get('operatorNextActions').textContent = operatorActions.filter(a => a.journey === selected &&
          project('actionAllowed', a.code, observation)).map(a => a.label).join(' · ') || view.detail;
      }
    }
    get('reviewResourcePolicyBtn').hidden = !project('recoveryPolicyVisible', observation);
    get('pointerPublicationSetup').hidden = !project('publicationSetupVisible', observation);
    get('pointerAdmissionControls').hidden = !project('admissionInputVisible', observation);
    if (project('publicationSetupInitiallyOpen', observation)) get('pointerPublicationSetup').open = true;
    get('vmCommandControls').hidden = !project('vmCommandVisible', observation);
    // Keep experimental output contextual even if it was opened on an earlier visit.
    if (selected !== 'resources') get('metricsLabSection').style.display = 'none';
    for (const action of operatorActions) {
      const control = get(action.control);
      control.textContent = action.label;
      control.title = action.help;
      control.setAttribute('aria-describedby', `${action.journey}Evidence`);
      control.disabled = !project('actionAllowed', action.code, observation);
      // A separate control makes reconciliation explicit, not a renamed write.
      if (action.id === 'publish') control.hidden = observation.publicationUnknown;
      if (action.id === 'reconcile') control.hidden = !observation.publicationUnknown;
    }
    return observation;
  }
  function allow(control) {
    const observation = render();
    if (experienceActionAllowed(control, observation)) return true;
    const action = operatorActions.find(a => a.control === control);
    onRefused(action ? `${action.label}: ${action.help}` : 'Unknown operator action refused.');
    return false;
  }
  render();
  return Object.freeze({ facts, render, allow, navigate: id => {
    const journey = operatorJourneys.find(j => j.id === id);
    if (!journey) throw new TypeError('Unknown operator journey');
    navigate(journey);
  } });
}
