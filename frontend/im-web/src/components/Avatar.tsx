import { Icon } from './Icon';

const palettes = ['sage', 'lilac', 'sand', 'blue', 'rose'];
export function Avatar({ name, id = 0, group = false, size = 'normal' }: { name: string; id?: number; group?: boolean; size?: 'small' | 'normal' | 'large' }) {
  return <span aria-hidden="true" className={`avatar avatar--${palettes[id % palettes.length]} avatar--${size} ${group ? 'avatar--group' : ''}`}>
    {group ? <Icon name="group" /> : (name.trim().slice(0, 1).toUpperCase() || '·')}
  </span>;
}
