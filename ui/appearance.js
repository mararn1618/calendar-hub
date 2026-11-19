import { element } from './dom.js';

function applyAppearance(theme) {
  document.documentElement.dataset.theme = theme;
  window.calendar?.setAppearance?.({ theme }).catch(error => console.warn('Window appearance could not be updated.', error));
}

applyAppearance(localStorage.getItem('appearance') === 'dark' ? 'dark' : 'light');

export function appearanceSettings() {
  const row = element('div', 'appearance-settings');
  const heading = element('h3', 'settings-subhead', 'Appearance');
  heading.id = 'appearance-heading';
  const options = element('div', 'appearance-options');
  options.setAttribute('role', 'radiogroup');
  options.setAttribute('aria-labelledby', heading.id);
  for (const name of ['Light', 'Dark']) {
    const theme = name.toLowerCase();
    const label = element('label');
    const radio = element('input');
    radio.type = 'radio';
    radio.name = 'appearance';
    radio.value = theme;
    radio.id = 'appearance-' + theme;
    radio.checked = document.documentElement.dataset.theme === theme;
    radio.addEventListener('change', () => {
      applyAppearance(theme);
      localStorage.setItem('appearance', theme);
    });
    label.append(radio, document.createTextNode(name));
    options.append(label);
  }
  row.append(heading, options);
  return row;
}
