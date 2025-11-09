// Parse structured doc comments (/// spec: format)

export type DocSpec = {
  description?: string;
  inputs?: Array<{ name: string; description: string }>;
  outputs?: string[];
  laws?: string[];
  fields?: Array<{ name: string; description: string }>;
};

/**
 * Parse a doc comment string into a structured DocSpec.
 * Returns null if the comment doesn't follow the spec: format.
 */
export function parseDocSpec(docComment: string): DocSpec | null {
  const lines = docComment.split('\n').map(line => line.trim());
  
  // Check if this is a spec: format doc comment
  if (lines.length === 0 || !lines[0] || !lines[0].startsWith('spec:')) {
    return null;
  }

  const spec: DocSpec = {};
  let currentSection: 'description' | 'inputs' | 'outputs' | 'laws' | 'fields' | null = null;
  let currentIndent = 0;
  let descriptionLines: string[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    
    if (!line) continue;

    // Detect section headers (e.g., "inputs:", "outputs:", "description: value")
    const colonIndex = line.indexOf(':');
    if (colonIndex !== -1 && !line.startsWith('-')) {
      const sectionName = line.slice(0, colonIndex).trim();
      const inlineValue = line.slice(colonIndex + 1).trim();
      
      // Save previous description if any
      if (currentSection === 'description' && descriptionLines.length > 0) {
        spec.description = descriptionLines.join(' ').trim();
        descriptionLines = [];
      }

      switch (sectionName) {
        case 'description':
          currentSection = 'description';
          if (inlineValue) {
            spec.description = inlineValue.replace(/^"(.*)"$/, '$1');
            currentSection = null; // Description is complete
          }
          break;
        case 'inputs':
          currentSection = 'inputs';
          spec.inputs = [];
          break;
        case 'outputs':
          currentSection = 'outputs';
          spec.outputs = [];
          break;
        case 'laws':
          currentSection = 'laws';
          spec.laws = [];
          break;
        case 'fields':
          currentSection = 'fields';
          spec.fields = [];
          break;
        default:
          currentSection = null;
      }
      continue;
    }

    // Parse content based on current section
    if (currentSection === 'description') {
      // Description can be inline or on next line
      const content = line.replace(/^"(.*)"$/, '$1'); // Remove quotes if present
      descriptionLines.push(content);
    } else if (currentSection === 'inputs' && line.startsWith('- ')) {
      // Parse "- name: description" format
      const match = line.slice(2).match(/^(\w+):\s*"?([^"]+)"?$/);
      if (match && match[1] && match[2]) {
        spec.inputs!.push({
          name: match[1],
          description: match[2].trim()
        });
      }
    } else if (currentSection === 'outputs' && line.startsWith('- ')) {
      // Parse "- description" format
      const content = line.slice(2).trim().replace(/^"(.*)"$/, '$1');
      spec.outputs!.push(content);
    } else if (currentSection === 'laws' && line.startsWith('- ')) {
      // Parse "- law" format
      const content = line.slice(2).trim().replace(/^"(.*)"$/, '$1');
      spec.laws!.push(content);
    } else if (currentSection === 'fields' && line.startsWith('- ')) {
      // Parse "- name: description" format
      const match = line.slice(2).match(/^(\w+):\s*"?([^"]+)"?$/);
      if (match && match[1] && match[2]) {
        spec.fields!.push({
          name: match[1],
          description: match[2].trim()
        });
      }
    }
  }

  // Save final description if any
  if (currentSection === 'description' && descriptionLines.length > 0) {
    spec.description = descriptionLines.join(' ').trim();
  }

  return spec;
}

/**
 * Validate that a DocSpec matches the declaration it's attached to.
 * Returns an array of validation errors, or an empty array if valid.
 */
export function validateDocSpec(
  spec: DocSpec,
  decl: { kind: string; name: string; params?: Array<{ name: string }>; fields?: Array<{ name: string }> }
): string[] {
  const errors: string[] = [];

  // For functions, validate input parameters match
  if (decl.kind === 'FnDecl' && spec.inputs && decl.params) {
    const specParamNames = spec.inputs.map(p => p.name);
    const declParamNames = decl.params.map(p => p.name);
    
    for (const specParam of specParamNames) {
      if (!declParamNames.includes(specParam)) {
        errors.push(`Doc spec references unknown parameter: ${specParam}`);
      }
    }
  }

  // For types, validate fields match
  if ((decl.kind === 'RecordTypeDecl' || decl.kind === 'SumTypeDecl') && spec.fields && decl.fields) {
    const specFieldNames = spec.fields.map(f => f.name);
    const declFieldNames = decl.fields.map(f => f.name);
    
    for (const specField of specFieldNames) {
      if (!declFieldNames.includes(specField)) {
        errors.push(`Doc spec references unknown field: ${specField}`);
      }
    }
  }

  return errors;
}
