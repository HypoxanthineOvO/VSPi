const UNSUPPORTED_FIELDS = new Set([
  '$schema', '$id', '$anchor', '$ref', '$defs', '$dynamicRef', '$dynamicAnchor', '$comment',
  'examples', 'prefixItems', 'unevaluatedProperties', 'unevaluatedItems', 'patternProperties',
  'additionalProperties', 'propertyNames', 'minItems', 'maxItems', 'uniqueItems', 'contains',
  'minContains', 'maxContains', 'additionalItems', 'minLength', 'maxLength', 'minimum', 'maximum',
  'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'pattern', 'format', 'contentEncoding',
  'contentMediaType', 'contentSchema', 'dependencies', 'dependentSchemas', 'dependentRequired',
  'x-mcp-header', 'deprecated', 'readOnly', 'writeOnly',
]);
const FIELD_NAMES: Record<string, string> = {
  additional_properties: 'additionalProperties', any_of: 'anyOf', prefix_items: 'prefixItems', property_ordering: 'propertyOrdering',
};

export function normalizeDevinGeminiSchema(value: unknown): unknown {
  if (value === true) return {};
  if (value === false) return { not: {} };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  const constraints: string[] = [];
  for (const [rawKey, entry] of Object.entries(source)) {
    const key = FIELD_NAMES[rawKey] ?? rawKey;
    if (UNSUPPORTED_FIELDS.has(key)) {
      if (!key.startsWith('$')) constraints.push(`${key}: ${JSON.stringify(entry)}`);
    } else if (key === 'properties' && entry && typeof entry === 'object' && !Array.isArray(entry)) {
      result[key] = Object.fromEntries(Object.entries(entry).map(([name, schema]) => [name, normalizeDevinGeminiSchema(schema)]));
    } else if (['anyOf', 'oneOf', 'allOf'].includes(key) && Array.isArray(entry)) {
      result[key] = entry.map(normalizeDevinGeminiSchema);
    } else if (['items', 'not', 'if', 'then', 'else'].includes(key)) {
      result[key] = normalizeDevinGeminiSchema(entry);
    } else result[key] = entry;
  }
  if (Array.isArray(result['type'])) {
    const types = [...new Set(result['type'].filter((entry): entry is string => typeof entry === 'string'))];
    const nonNull = types.filter(type => type !== 'null');
    if (types.includes('null')) result['nullable'] = true;
    if (nonNull.length === 1) result['type'] = nonNull[0];
    else {
      delete result['type'];
      if (nonNull.length > 1) {
        const union = nonNull.map(type => ({ type }));
        if (result['anyOf'] !== undefined) result['allOf'] = [...Array.isArray(result['allOf']) ? result['allOf'] : [], { anyOf: result['anyOf'] }, { anyOf: union }];
        result['anyOf'] = union;
      }
    }
  }
  if (result['type'] === 'null') { delete result['type']; result['nullable'] = true; }
  if (Object.hasOwn(result, 'const')) {
    result['enum'] = [result['const']];
    delete result['const'];
  }
  if (Array.isArray(result['enum'])) {
    const values = result['enum'];
    if (result['type'] === undefined && values.length > 0) {
      const types = new Set(values.filter(entry => entry !== null).map(entry => typeof entry));
      if (types.size === 1 && ['string', 'number', 'boolean'].includes([...types][0]!)) result['type'] = [...types][0];
      if (values.includes(null)) result['nullable'] = true;
    }
    if (result['type'] !== 'string') { constraints.push(`enum: ${JSON.stringify(values)}`); delete result['enum']; }
  }
  if (result['type'] === 'object') {
    result['properties'] ??= {};
    result['propertyOrdering'] ??= Object.keys(result['properties'] as object);
  }
  if (constraints.length > 0) result['description'] = [result['description'], ...constraints].filter(Boolean).join('\n');
  return result;
}
