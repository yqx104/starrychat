import { Icon } from './Icon';

const palettes = ['sage', 'lilac', 'sand', 'blue', 'rose'];
export function Avatar({ name, id = '', group = false, size = 'normal' }: { name: string; id?: string; group?: boolean; size?: 'small' | 'normal' | 'large' }) {
  return <span aria-hidden="true" className={`avatar avatar--${palettes[Array.from(id).reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 0) % palettes.length]} avatar--${size} ${group ? 'avatar--group' : ''}`}>
    {group ? <Icon name="group" /> : (name.trim().slice(0, 1).toUpperCase() || '·')}
  </span>;
}
