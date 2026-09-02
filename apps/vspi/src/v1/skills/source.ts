import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export function normalizeSkillInstallSource(value: string): string {
  const source = value.trim();
  if (!source || source.length > 2_048 || /[\p{Cc}\p{Cf}]/u.test(source)) throw new Error('Skill 来源格式无效');
  if (source.startsWith('npm:')) {
    if (!/^npm:(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+(?:@[a-z0-9*^~<>=|. -]+)?$/iu.test(source)) {
      throw new Error('npm Skill 来源格式无效');
    }
    return source;
  }
  if (/^https?:\/\//iu.test(source) || /^ssh:\/\//iu.test(source)) {
    const url = new URL(source);
    if (url.password || url.search || (url.protocol !== 'ssh:' && url.username)) {
      throw new Error('Skill URL 不能包含凭据或查询参数');
    }
    return source;
  }
  if (/^(?:git@|git:\/\/)/iu.test(source)) return source;
  if (isAbsolute(source) && existsSync(source)) return source;
  throw new Error('Skill 来源必须是 npm:、Git URL 或存在的绝对路径');
}
