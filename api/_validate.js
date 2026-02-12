// Lightweight input validation for POST body schemas

function validate(body, schema) {
  const errors = [];

  for (const [field, rules] of Object.entries(schema)) {
    const value = body[field];

    if (rules.required && (value === undefined || value === null || value === '')) {
      errors.push(`${field} is required`);
      continue;
    }

    if (value === undefined || value === null) continue;

    if (rules.type === 'string' && typeof value !== 'string') {
      errors.push(`${field} must be a string`);
    } else if (rules.type === 'number' && typeof value !== 'number') {
      errors.push(`${field} must be a number`);
    } else if (rules.type === 'array' && !Array.isArray(value)) {
      errors.push(`${field} must be an array`);
    }

    if (rules.maxLength && typeof value === 'string' && value.length > rules.maxLength) {
      errors.push(`${field} exceeds max length of ${rules.maxLength}`);
    }

    if (rules.max && typeof value === 'number' && value > rules.max) {
      errors.push(`${field} exceeds max value of ${rules.max}`);
    }

    if (rules.maxItems && Array.isArray(value) && value.length > rules.maxItems) {
      errors.push(`${field} exceeds max items of ${rules.maxItems}`);
    }
  }

  return errors.length ? errors : null;
}

module.exports = { validate };
