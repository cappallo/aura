{
	function foldList(head, tail, valueIndex) {
		if (head === undefined || head === null) {
			return [];
		}
		return [head, ...tail.map((part) => part[valueIndex])];
	}

	function foldBinary(head, tail) {
		return tail.reduce(
			(lhs, part) => ({
				kind: "BinaryExpr",
				op: part[1],
				left: lhs,
				right: part[3],
				loc: lhs.loc || undefined,
			}),
			head,
		);
	}
}

start
	= WSAny* module:Module WSAny* { return module; }

Module
	= "module" __ name:ModuleName Terminator+ imports:Import* decls:TopLevelDecl* {
			return {
				kind: "Module",
				name,
				imports,
				decls,
			};
		}

ModuleName
	= head:Ident tail:("." Ident)* {
			return [head, ...tail.map((part) => part[1])];
		}

Import
	= "import" __ name:ModuleName alias:Alias? Terminator+ {
			return {
				kind: "ImportDecl",
				moduleName: name,
				alias,
			};
		}

Alias
	= __ "as" __ alias:Ident { return alias; }

TopLevelDecl
	= BlockGap? docs:DocCommentBlock? decl:TopLevelDeclCore { 
			if (docs) {
				decl.docComment = docs;
			}
			return decl; 
		}

DocCommentBlock
	= head:DocCommentLine tail:(NL DocCommentLine)* NL? {
			return [head, ...tail.map(t => t[1])].join("\n");
		}

DocCommentLine
	= _? comment:DocComment { return comment; }

TopLevelDeclCore
	= EffectDecl
	/ SchemaDecl
	/ TypeDecl
	/ FnDecl
	/ ActorDecl
	/ ContractDecl
	/ TestDecl
	/ PropertyDecl

EffectDecl
	= "effect" __ name:Ident Terminator+ {
			return {
				kind: "EffectDecl",
				name,
			};
		}

SchemaDecl
	= "@version" _ "(" _ version:Integer _ ")" Terminator+ "schema" __ name:Ident __ "{" BlockGap fields:SchemaFieldList? BlockGap "}" Terminator+ {
			return {
				kind: "SchemaDecl",
				name,
				version: version,
				fields: fields || [],
			};
		}

SchemaFieldList
	= head:SchemaField tail:(FieldSeparator SchemaField)* {
			return [head, ...tail.map((part) => part[1])];
		}

SchemaField
	= _? name:Ident _ ":" _ type:TypeExpr optional:"?"? {
			return { name, type, optional: optional !== null };
		}

TypeDecl
	= "type" __ name:Ident params:TypeParams? __ "=" __ sum:SumType Terminator+ {
			return {
				kind: "SumTypeDecl",
				name,
				typeParams: params || [],
				variants: sum,
			};
		}
	/ "type" __ name:Ident params:TypeParams? __ "=" __ alias:TypeExpr Terminator+ {
			return {
				kind: "AliasTypeDecl",
				name,
				typeParams: params || [],
				target: alias,
			};
		}
		/ "type" __ name:Ident params:TypeParams? __ "{" BlockGap fields:FieldDeclList? BlockGap "}" Terminator+ {
			return {
				kind: "RecordTypeDecl",
				name,
				typeParams: params || [],
				fields: fields || [],
			};
		}

TypeParams
	= "<" _ head:Ident tail:(_ "," _ Ident)* _ ">" {
			return foldList(head, tail, 3);
		}

SumType
	= first:Variant rest:(__ "|" __ Variant)* {
			return [first, ...rest.map((part) => part[3])];
		}

Variant
	= name:CtorName __ "{" BlockGap fields:FieldDeclList? BlockGap "}" {
			return { name, fields: fields || [] };
		}
	/ name:CtorName {
			return { name, fields: [] };
		}

FieldDeclList
	= head:Field tail:(FieldSeparator Field)* {
			return [head, ...tail.map((part) => part[1])];
		}

FieldSeparator
	= _ (NL)+
	/ _ "," _


Field
	= _? name:Ident _ ":" _ type:TypeExpr {
			return { name, type };
		}

FnDecl
	= "fn" __ name:Ident typeParams:TypeParams? _ "(" _ params:ParamList? _ ")" __ returnSpec:ReturnSpec _ body:Block {
			return {
				kind: "FnDecl",
				name,
				typeParams: typeParams || [],
				params: params || [],
				returnType: returnSpec.type,
				effects: returnSpec.effects,
				body,
			};
		}

ActorDecl
	= "actor" __ name:Ident _ "(" _ params:ParamList? _ ")" __ "{" BlockGap state:ActorState? handlers:ActorHandler* BlockGap "}" Terminator* {
			return {
				kind: "ActorDecl",
				name,
				params: params || [],
				stateFields: state || [],
				handlers: handlers || [],
			};
		}

ActorState
	= "state" __ "{" BlockGap fields:FieldDeclList? BlockGap "}" Terminator+ {
			return fields || [];
		}

ActorHandler
	= BlockGap? "on" __ msgType:Ident _ "(" _ msgParams:ParamList? _ ")" __ returnSpec:ReturnSpec _ body:Block Terminator* {
			return {
				kind: "ActorHandler",
				msgTypeName: msgType,
				msgParams: msgParams || [],
				returnType: returnSpec.type,
				effects: returnSpec.effects,
				body,
			};
		}

ContractDecl
	= "contract" __ "fn" __ name:Ident _ "(" _ params:ParamList? _ ")" returnType:ContractReturnType? _ "{" BlockGap clauses:ContractClauseList? BlockGap "}" Terminator* {
			const allClauses = clauses || [];
			const requires = allClauses.filter((clause) => clause.kind === "Requires").map((clause) => clause.expr);
			const ensures = allClauses.filter((clause) => clause.kind === "Ensures").map((clause) => clause.expr);
			return {
				kind: "FnContractDecl",
				name,
				params: params || [],
				returnType: returnType || null,
				requires,
				ensures,
			};
		}

ContractReturnType
	= __ "->" __ type:TypeExpr { return type; }

ContractClauseList
	= head:ContractClause tail:(BlockGap ContractClause)* {
			return [head, ...tail.map((part) => part[1])];
		}

ContractClause
	= "requires" __ expr:Expr Terminator+ {
			return { kind: "Requires", expr };
		}
	/ "ensures" __ expr:Expr Terminator+ {
			return { kind: "Ensures", expr };
		}

ReturnSpec
	= "->" __ "[" _ effects:EffectList _ "]" __ type:TypeExpr {
            return { type, effects };
		}
	/ "->" __ type:TypeExpr {
			return { type, effects: [] };
		}

EffectList
	= head:Ident tail:(_ "," _ Ident)* {
            return foldList(head, tail, 3);
		}

ParamList
	= head:Param tail:(_ "," _ Param)* {
			return foldList(head, tail, 3);
		}

Param
	= name:Ident _ ":" _ type:TypeExpr {
			return { name, type };
		}

TestDecl
	= "test" __ name:Ident _ body:Block {
			return {
				kind: "TestDecl",
				name,
				body,
			};
		}

PropertyDecl
	= "property" __ name:Ident _ "(" _ params:PropertyParamList? _ ")" _ body:Block {
			return {
				kind: "PropertyDecl",
				name,
				params: params || [],
				body,
			};
		}

PropertyParamList
	= head:PropertyParam tail:(_ "," _ PropertyParam)* {
			return foldList(head, tail, 3);
		}

PropertyParam
	= name:Ident _ ":" _ type:TypeExpr predicate:PropertyPredicate? {
			return { name, type, predicate }; 
		}

PropertyPredicate
	= __ "where" __ expr:Expr { return expr; }

Block
	= "{" BlockGap stmts:StmtList? BlockGap "}" {
			return {
				kind: "Block",
				stmts: stmts || [],
			};
		}

StmtList
	= head:Stmt tail:((NL)* Stmt)* {
			return [head, ...tail.map((part) => part[1])];
		}

Stmt
	= LetStmt
	/ ReturnStmt
	/ MatchStmt
	/ AsyncGroupStmt
	/ AsyncStmt
	/ ExprStmt

LetStmt
	= "let" __ name:Ident __ "=" __ expr:Expr Terminator+ {
			return {
				kind: "LetStmt",
				name,
				expr,
				loc: location(),
			};
		}

ReturnStmt
	= "return" __ expr:Expr Terminator+ {
			return {
				kind: "ReturnStmt",
				expr,
				loc: location(),
			};
		}

ExprStmt
	= expr:Expr Terminator+ {
			return {
				kind: "ExprStmt",
				expr,
				loc: location(),
			};
		}

MatchStmt
	= "match" __ scrutinee:Expr __ "{" BlockGap cases:MatchCase* BlockGap "}" Terminator* {
			return {
				kind: "MatchStmt",
				scrutinee,
				cases,
			};
		}

AsyncGroupStmt
	= "async_group" __ body:Block Terminator* {
		return {
			kind: "AsyncGroupStmt",
			body,
			loc: location(),
		};
	}

AsyncStmt
	= "async" __ body:Block Terminator* {
		return {
			kind: "AsyncStmt",
			body,
			loc: location(),
		};
	}

MatchExpr
	= "match" __ scrutinee:Expr __ "{" BlockGap cases:MatchCase* BlockGap "}" {
			return {
				kind: "MatchExpr",
				scrutinee,
				cases,
				loc: location(),
			};
		}

MatchCase
	= "case" __ pattern:Pattern __ "=>" _ body:Block Terminator* {
			return {
				pattern,
				body,
			};
		}

Pattern
	= "_" { return { kind: "WildcardPattern" }; }
	/ ctor:CtorName __ "{" __ fields:PatternFieldList? __ "}" {
			return {
				kind: "CtorPattern",
				ctorName: ctor,
				fields: fields || [],
			};
		}
	/ ctor:CtorName {
			return {
				kind: "CtorPattern",
				ctorName: ctor,
				fields: [],
			};
		}
	/ name:Ident {
			return {
				kind: "VarPattern",
				name,
			};
		}

PatternFieldList
	= head:PatternField tail:(__ "," __ PatternField)* {
			return foldList(head, tail, 3);
		}

PatternField
	= name:Ident _ ":" _ pattern:Pattern {
			return { name, pattern };
		}
	/ name:Ident {
			return { name, pattern: { kind: "VarPattern", name } };
		}

Expr
	= IfExpr
	/ LogicOrExpr

IfExpr
	= "if" __ cond:Expr __ thenBlock:Block elsePart:ElseClause? {
			return {
				kind: "IfExpr",
				cond,
				thenBranch: thenBlock,
				elseBranch: elsePart || undefined,
				loc: location(),
			};
		}

ElseClause
	= __? "else" __ block:Block { return block; }

LogicOrExpr
	= head:LogicAndExpr tail:(__ "||" __ LogicAndExpr)* { return foldBinary(head, tail); }

LogicAndExpr
	= head:ConcatExpr tail:(__ "&&" __ ConcatExpr)* { return foldBinary(head, tail); }

ConcatExpr
	= head:EqualityExpr tail:(__ "++" __ EqualityExpr)* { return foldBinary(head, tail); }

EqualityExpr
	= head:RelationalExpr tail:(__ ("==" / "!=") __ RelationalExpr)* { return foldBinary(head, tail); }

RelationalExpr
	= head:AdditiveExpr tail:(__ ("<=" / "<" / ">=" / ">") __ AdditiveExpr)* { return foldBinary(head, tail); }

AdditiveExpr
	= head:MultiplicativeExpr tail:(__ ("+" / "-") __ MultiplicativeExpr)* { return foldBinary(head, tail); }

MultiplicativeExpr
	= head:UnaryExpr tail:(__ ("*" / "/") __ UnaryExpr)* { return foldBinary(head, tail); }

UnaryExpr
	= op:("-" / "!") _ expr:UnaryExpr {
			return {
				kind: "CallExpr",
				callee: op === "-" ? "__negate" : "__not",
				args: [{ kind: "PositionalArg", expr }],
				loc: location(),
			};
		}
	/ PrimaryExpr

PrimaryExpr
	= base:BaseExpr tail:PostfixSegment* {
			return tail.reduce(
				(target, segment) => {
					if (segment.kind === "field") {
						return {
							kind: "FieldAccessExpr",
							target,
							field: segment.field,
							loc: target.loc,
						};
					}
					return {
						kind: "IndexExpr",
						target,
						index: segment.index,
						loc: target.loc,
					};
				},
				base,
			);
		}

PostfixSegment
	= "." field:Ident { return { kind: "field", field }; }
	/ "[" _ index:Expr _ "]" { return { kind: "index", index }; }

BaseExpr
	= MatchExpr
	/ ListLiteral
	/ RecordLiteral
	/ HoleExpr
	/ CallExpr
	/ IntLiteral
	/ StringLiteral
	/ BoolLiteral
	/ VarExpr
	/ ParenthesizedExpr

ListLiteral
	= "[" BlockGap? _ elements:ExprList? BlockGap? _ "]" {
			return {
				kind: "ListLiteral",
				elements: elements || [],
				loc: location(),
			};
		}

ExprList
	= head:Expr tail:(BlockGap? _ "," BlockGap? _ Expr)* {
			return foldList(head, tail, 5);
		}

RecordLiteral
	= name:CtorName __ "{" BlockGap fields:RecordFieldList? BlockGap "}" {
			return {
				kind: "RecordExpr",
				typeName: name,
				fields: fields || [],
				loc: location(),
			};
		}

RecordFieldList
	= head:RecordField tail:(RecordFieldSeparator RecordField)* {
			return [head, ...tail.map((part) => part[1])];
		}

RecordFieldSeparator
	= (NL)+
	/ _ "," WSAny


RecordField
	= _? name:Ident _ ":" _ expr:Expr {
			return { name, expr };
		}

CallExpr
	= callee:QualifiedIdent _ "(" BlockGap? _ args:CallArgList? BlockGap? _ ")" {
			return {
				kind: "CallExpr",
				callee,
				args: args || [],
				loc: location(),
			};
		}

CallArgList
	= head:CallArg tail:(BlockGap? _ "," BlockGap? _ CallArg)* {
			return foldList(head, tail, 5);
		}

CallArg
	= name:Ident _ "=" _ expr:Expr {
			return { kind: "NamedArg", name, expr };
		}
	/ expr:Expr {
			return { kind: "PositionalArg", expr };
		}

HoleExpr
	= "hole" _ "(" BlockGap? _ label:StringLiteral? BlockGap? _ ")" {
			return {
				kind: "HoleExpr",
				label: label ? label.value : undefined,
				loc: location(),
			};
		}

IntLiteral
	= digits:Integer {
			return {
				kind: "IntLiteral",
				value: parseInt(digits, 10),
				loc: location(),
			};
		}

StringLiteral
	= '"' chars:DoubleStringCharacter* '"' {
			return {
				kind: "StringLiteral",
				value: chars.join(""),
				loc: location(),
			};
		}

DoubleStringCharacter
	= !('"' / "\\") char:. { return char; }
	/ "\\" esc:("\\" / '"' / "n" / "t") {
			switch (esc) {
				case "n":
					return "\n";
				case "t":
					return "\t";
				case "\\":
					return "\\";
				case '"':
					return '"';
				default:
					return esc;
			}
		}

BoolLiteral
	= "true" { return { kind: "BoolLiteral", value: true, loc: location() }; }
	/ "false" { return { kind: "BoolLiteral", value: false, loc: location() }; }

VarExpr
	= name:Ident {
			return {
				kind: "VarRef",
				name,
				loc: location(),
			};
		}

ParenthesizedExpr
	= "(" _ expr:Expr _ ")" { return expr; }

TypeExpr
	= base:TypePrimary optional:("?" { return true; })? {
			if (optional) {
				return { kind: "OptionalType", inner: base };
			}
			return base;
		}

TypePrimary
	= name:Ident typeArgs:TypeArgList? {
			return { kind: "TypeName", name, typeArgs: typeArgs || [] };
		}
	/ "(" __ type:TypeExpr __ ")" { return type; }

TypeArgList
	= "<" _ head:TypeExpr tail:(_ "," _ TypeExpr)* _ ">" {
			return foldList(head, tail, 3);
		}

BlockGap
	= GapUnit*

GapUnit
	= NL
	/ [ \t]+
	/ Comment

Integer
	= digits:[0-9]+ { return parseInt(digits.join(""), 10); }

Ident
	= $([a-zA-Z_][a-zA-Z0-9_@]*)

QualifiedIdent
	= head:Ident tail:("." Ident)* {
			if (tail.length === 0) {
				return head;
			}
			return [head, ...tail.map((part) => part[1])].join(".");
		}

CtorName
	= $([A-Z][a-zA-Z0-9_@]*)

// Comments
DocComment
	= "///" _ text:(![\n\r] .)* { return text.map(t => t[1]).join(""); }

LineComment
	= "//" !"/" (![\n\r] .)*

BlockComment
	= "/*" (!"*/" .)* "*/"

Comment
	= LineComment / BlockComment

// Whitespace (includes comments)
NL
	= [\n\r]+

_
	= ([ \t] / Comment)*

__
	= ([ \t] / Comment)+

WSAny
	= [ \t\n\r] / Comment

Terminator
	= _? ";" _?
	/ _? (NL)+ _?
