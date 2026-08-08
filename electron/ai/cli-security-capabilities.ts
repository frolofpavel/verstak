// Честная матрица защиты секретов по CLI-провайдерам (1.9.6 #2) переехала в
// shared/contracts/cli-capability.ts — одна правда на renderer и main (раньше
// уровень дублировался в src/lib/runtime-capability.ts и держался синхронным
// анти-дрейф-тестом). Ре-экспорт сохраняет существующих импортёров main
// (runner-plain.ts, cli-security-capabilities.test.ts).
export {
  secretProtectionLevel,
  type SecretProtectionLevel,
  type CliSecurityCapability,
} from '../../shared/contracts/cli-capability'
