---
title: Schema directives
description: Implementing and using custom `@directive`s that transform schema types, fields, and arguments
---

## Schema directives

A _directive_ is an identifier preceded by a `@` character, optionally followed by a list of named arguments, which can appear after almost any form of syntax in the GraphQL query or schema languages.

The [GraphQL specification](http://facebook.github.io/graphql/October2016/#sec-Type-System.Directives) requires every server implementation to support at least two directives, `@skip(if: Boolean)` and `@include(if: Boolean)`, which can be used during query execution to conditionally omit or include certain fields. The [GraphQL.js reference implementation](https://github.com/graphql/graphql-js) provides one additional built-in [`@deprecated`](https://github.com/graphql/graphql-js/blob/master/src/type/directives.js) directive, which is useful for indicating that a field or `enum` value should no longer be used.

However, the formal syntax of the GraphQL query and schema languages allows arbitrary user-defined `@directive`s to appear as modifiers following almost any kind of type, field, or argument. Unless the server ascribes special meaning to these annotations, they are typically ignored after parsing, almost as if they were comments. But if the server knows how to interpret them, `@directive` annotations can be a powerful tool for preventing repetition, specifying extra behavior, enforcing additional type or value restrictions, and enabling static analysis.

This document focuses on `@directive`s that appear in GraphQL _schemas_ written in Schema Definition Language (SDL), as described in the [Schemas and Types](http://graphql.org/learn/schema/) section of the GraphQL.org documentation. These `@directive`s can be used to modify the structure and behavior of a GraphQL schema in ways that would not be possible using SDL syntax alone.

In order for a `@directive` to have any consequences, the GraphQL server must be configured to apply a specific implementation of that `@directive` to the `GraphQLSchema` object. This document describes one possible approach to defining reusable `@directive` implementations, namely the `SchemaDirectiveVisitor` abstraction provided by the `graphql-tools` npm package.

The possible applications of `@directive` syntax are numerous: enforcing access permissions, formatting date strings, auto-generating resolver functions for a particular backend API, marking strings for internationalization, synthesizing globally unique object identifiers, specifying caching behavior, skipping or including or deprecating fields, and just about anything else you can imagine.

## Implementing schema directives

Since the GraphQL specification does not discuss any specific implementation strategy for `@directive`s, it's up to each GraphQL server framework to expose an API for implementing new directives.

If you're using Apollo Server, you are also likely to be using the [`graphql-tools`](https://github.com/apollographql/graphql-tools) npm package, which provides a convenient yet powerful tool for implementing `@directive` syntax: the [`SchemaDirectiveVisitor`](https://github.com/apollographql/graphql-tools/blob/wip-schema-directives/src/schemaVisitor.ts) class.

To implement a schema `@directive` using `SchemaDirectiveVisitor`, simply create a subclass of `SchemaDirectiveVisitor` that overrides one or more of the following visitor methods:

* `visitSchema(schema: GraphQLSchema)`
* `visitScalar(scalar: GraphQLScalarType)`
* `visitObject(object: GraphQLObjectType)`
* `visitFieldDefinition(field: GraphQLField<any, any>)`
* `visitArgumentDefinition(argument: GraphQLArgument)`
* `visitInterface(iface: GraphQLInterfaceType)`
* `visitUnion(union: GraphQLUnionType)`
* `visitEnum(type: GraphQLEnumType)`
* `visitEnumValue(value: GraphQLEnumValue)`
* `visitInputObject(object: GraphQLInputObjectType)`
* `visitInputFieldDefinition(field: GraphQLInputField)`

By overriding methods like `visitObject`, a subclass of `SchemaDirectiveVisitor` expresses interest in certain schema types such as `GraphQLObjectType` (the first parameter type of `visitObject`).

When `SchemaDirectiveVisitor.visitSchemaDirectives` is called with a `GraphQLSchema` object and a map of visitor subclasses (`{ [directiveName: string]: typeof SchemaDirectiveVisitor }`), visitor methods overridden by those subclasses will be called with references to any schema type objects that have appropriately named `@directive`s attached to them, enabling the visitors to inspect or modify the schema.

For example, if a directive called `@rest(url: "...")` appears after a field definition, a `SchemaDirectiveVisitor` subclass could provide meaning to that directive by overriding the `visitFieldDefinition` method (which receives a `GraphQLField` parameter), and then the body of that visitor method could manipulate the field's resolver function to fetch data from a REST endpoint:

```typescript
import {
  makeExecutableSchema,
  SchemaDirectiveVisitor,
} from "graphql-tools";

const typeDefs = `
type Query {
  people: [Person] @rest(url: "/api/v1/people")
}`;

const schema = makeExecutableSchema({ typeDefs });

SchemaDirectiveVisitor.visitSchemaDirectives(schema, {
  rest: class extends SchemaDirectiveVisitor {
    public visitFieldDefinition(field: GraphQLField<any, any>) {
      const { url } = this.args;
      field.resolve = () => fetch(url);
    }
  }
});
```

The subclass in this example is defined as an anonymous `class` expression, for brevity. A truly reusable `SchemaDirectiveVisitor` would most likely be defined in a library using a named class declaration, and then exported for consumption by other modules and packages.

It's also possible to pass directive implementations to `makeExecutableSchema` via the `directiveVisitors` parameter, if you prefer:

```typescript
const schema = makeExecutableSchema({
  typeDefs,
  directiveVisitors: {
    rest: class extends SchemaDirectiveVisitor {
      public visitFieldDefinition(field: GraphQLField<any, any>) {
        const { url } = this.args;
        field.resolve = () => fetch(url);
      }
    }
  }
});
```

Note that a subclass of `SchemaDirectiveVisitor` may be instantiated multiple times to visit multiple different `@directive` occurrences, or even `@directive`s of different names. In other words, `SchemaDirectiveVisitor` implementations are effectively anonymous, and it's up to the caller of `SchemaDirectiveVisitor.visitSchemaDirectives` to assign names to them.

## Declaring schema directives

While the above examples should be sufficient to implement any `@directive` used in your schema, SDL syntax also supports declaring the names, argument types, default argument values, and permissible locations of any available directives:

```js
directive @auth(
  requires: Role = ADMIN,
) on OBJECT | FIELD_DEFINITION

enum Role {
  ADMIN
  REVIEWER
  USER
  UNKNOWN
}

type User @auth(requires: USER) {
  name: String
  banned: Boolean @auth(requires: ADMIN)
  canPost: Boolean @auth(requires: REVIEWER)
}
```

This hypothetical `@auth` directive takes an argument named `requires` of type `Role`, which defaults to `ADMIN` if `@auth` is used without passing an explicit `requires` argument. The `@auth` directive can appear on an `OBJECT` like `User` to set a default access control for all `User` fields, and also on individual fields, to enforce field-specific `@auth` restrictions.

Enforcing the requirements of the declaration is something a `SchemaDirectiveVisitor` implementation could do itself, in theory, but the SDL syntax is easer to read and write, and provides value even if you're not using the `SchemaDirectiveVisitor` abstraction.

However, if you're attempting to implement a reusable `SchemaDirectiveVisitor`, you may not be the one writing the SDL syntax, so you may not have control over which directives the schema author decides to declare, and how. That's why a well-implemented, reusable `SchemaDirectiveVisitor` should consider overriding the `getDirectiveDeclaration` method:

```typescript
import {
  DirectiveLocation,
  GraphQLDirective,
  GraphQLEnumType,
} from "graphql";

class AuthDirectiveVisitor extends SchemaDirectiveVisitor {
  public visitObject(object: GraphQLObjectType) {...}
  public visitFieldDefinition(field: GraphQLField<any, any>) {...}

  public static getDirectiveDeclaration(
    directiveName: string,
    schema: GraphQLSchema,
  ): GraphQLDirective {
    const previousDirective = schema.getDirective(directiveName);
    if (previousDirective) {
      // If a previous directive declaration exists in the schema, it may be
      // better to modify it than to return a new GraphQLDirective object.
      previousDirective.args.forEach(arg => {
        if (arg.name === 'requires') {
          // Lower the default minimum Role from ADMIN to REVIEWER.
          arg.defaultValue = 'REVIEWER';
        }
      });

      return previousDirective;
    }

    // If a previous directive with this name was not found in the schema,
    // there are several options:
    //
    // 1. Construct a new GraphQLDirective (see below).
    // 2. Throw an exception to force the client to declare the directive.
    // 3. Return null, and forget about declaring this directive.
    //
    // All three are valid options, since the visitor will still work without
    // any declared directives. In fact, unless you're publishing a directive
    // implementation for public consumption, you can probably just ignore
    // getDirectiveDeclaration altogether.

    return new GraphQLDirective({
      name: directiveName,
      locations: [
        DirectiveLocation.OBJECT,
        DirectiveLocation.FIELD_DEFINITION,
      ],
      args: {
        requires: {
          // Having the schema available here is important for obtaining
          // references to existing type objects, such as the Role enum.
          type: (schema.getType('Role') as GraphQLEnumType),
          // Set the default minimum Role to REVIEWER.
          defaultValue: 'REVIEWER',
        }
      }]
    });
  }
}
```

Since the `getDirectiveDeclaration` method receives not only the name of the directive but also the `GraphQLSchema` object, it can modify and/or reuse previous declarations found in the schema, as an alternative to returning a totally new `GraphQLDirective` object. Either way, if the visitor returns a non-null `GraphQLDirective` from `getDirectiveDeclaration`, that declaration will be used to check arguments and permissible locations.

## Examples

To appreciate the range of possibilities enabled by `SchemaDirectiveVisitor`, let's examine a variety of practical examples.

> Note that these examples are written in JavaScript rather than TypeScript, though either language should work.

### Uppercasing strings

Suppose you want to ensure a string-valued field is converted to uppercase:

```typescript
import { defaultFieldResolver } from "graphql";

const typeDefs = `
directive @upper on FIELD_DEFINITION

type Query {
  hello: String @upper
}`;

class UpperCaseVisitor extends SchemaDirectiveVisitor {
  visitFieldDefinition(field) {
    const { resolve = defaultFieldResolver } = field;
    field.resolve = async function (...args) {
      const result = await resolve.apply(this, args);
      if (typeof result === "string") {
        return result.toUpperCase();
      }
      return result;
    };
  }
}

const schema = makeExecutableSchema({
  typeDefs,
  directiveVisitors: {
    upper: UpperCaseVisitor
  }
});
```

### Formatting date strings

Suppose your resolver returns a `Date` object but you want to return a formatted string to the client:

```typescript
import { defaultFieldResolver } from "graphql";

const typeDefs = `
directive @date(format: String) on FIELD_DEFINITION

scalar Date

type Post {
  published: Date @date(format: "mmmm d, yyyy")
}`;

class DateFormatVisitor extends SchemaDirectiveVisitor {
  visitFieldDefinition(field) {
    const { resolve = defaultFieldResolver } = field;
    const { format } = this.args;
    field.type = GraphQLString;
    field.resolve = async function (...args) {
      const date = await resolve.apply(this, args);
      return require('dateformat')(date, format);
    };
  }
}

const schema = makeExecutableSchema({
  typeDefs,
  directiveVisitors: {
    date: DateFormatVisitor
  }
});
```

### Marking strings for internationalization

```typescript
import { defaultFieldResolver } from "graphql";

const typeDefs = `
directive @intl on FIELD_DEFINITION

type Query {
  greeting: String @intl
}`;

class IntlVisitor extends SchemaDirectiveVisitor {
  visitFieldDefinition(field, details) {
    const { resolve = defaultFieldResolver } = field;
    field.resolve = async function (...args) {
      const context = args[2];
      const defaultText = await resolve.apply(this, args);
      // In this example, path would be ["Query", "greeting"]:
      const path = [details.objectType.name, field.name];
      return translate(defaultText, path, context.locale);
    };
  }
}

const schema = makeExecutableSchema({
  typeDefs,
  directiveVisitors: {
    intl: IntlVisitor
  }
});
```

### Enforcing access permissions

Suppose you want to implement the `@auth` example mentioned above:

```typescript
import { defaultFieldResolver } from "graphql";

const typeDefs = `
directive @auth(
  requires: Role = ADMIN,
) on OBJECT | FIELD_DEFINITION

enum Role {
  ADMIN
  REVIEWER
  USER
  UNKNOWN
}

type User @auth(requires: USER) {
  name: String
  banned: Boolean @auth(requires: ADMIN)
  canPost: Boolean @auth(requires: REVIEWER)
}`;

const authReqSymbol = Symbol.for("@auth required role");
const authWrapSymbol = Symbol.for("@auth wrapped");

class AuthVisitor extends SchemaDirectiveVisitor {
  visitObject(type) {
    this.ensureFieldsWrapped(type);
    type[authReqSymbol] = this.args.requires;
  }

  visitFieldDefinition(field, details) {
    this.ensureFieldsWrapped(details.objectType);
    field[authReqSymbol] = this.args.requires;
  }

  ensureFieldsWrapped(type) {
    // Mark the GraphQLObjectType object to avoid re-wrapping its fields:
    if (type[authWrapSymbol]) {
      return;
    }

    const fields = type.getFields();
    Object.keys(fields).forEach(fieldName => {
      const field = fields[fieldName];
      const { resolve = defaultFieldResolver } = field;
      field.resolve = async function (...args) {
        // Get the required role from the field first, falling back to the
        // parent GraphQLObjectType if no role is required by the field:
        const requiredRole = field[authReqSymbol] || type[authReqSymbol];
        if (! requiredRole) {
          return resolve.apply(this, args);
        }
        const context = args[2];
        const user = await getUser(context.headers.authToken);
        if (! user.hasRole(requiredRole)) {
          throw new Error("not authorized");
        }
        return resolve.apply(this, args);
      };
    });

    type[authWrapSymbol] = true;
  }
};

const schema = makeExecutableSchema({
  typeDefs,
  directiveVisitors: {
    auth: AuthVisitor
  }
});
```

### Enforcing value restrictions

Suppose you want to enforce a maximum length for a string-valued field:

```typescript
const typeDefs = `
directive @length(max: Int) on FIELD_DEFINITION | INPUT_FIELD_DEFINITION

type Query {
  books: [Book]
}

type Book {
  title: String @length(max: 50)
}

type Mutation {
  createBook(book: BookInput): Book
}

input BookInput {
  title: String! @length(max: 50)
}`;

class LimitedLengthType extends GraphQLScalarType {
  constructor(type, maxLength) {
    super({
      name: `LengthAtMost${maxLength}`,
      serialize(value) {
        assert.strictEqual(typeof value, 'string');
        assert.isAtMost(value.length, maxLength);
        return value;
      }
    });
  }
}

class LengthVisitor extends SchemaDirectiveVisitor {
  visitInputFieldDefinition(field) {
    this.wrapType(field);
  }

  visitFieldDefinition(field) {
    this.wrapType(field);
  }

  wrapType(field) {
    // This LimitedLengthType should be just like field.type except that the
    // serialize method enforces the length limit. For more information about
    // GraphQLScalar type serialization, see the graphql-js implementation:
    // https://github.com/graphql/graphql-js/blob/31ae8a8e8312494b858b69b2ab27b1837e2d8b1e/src/type/definition.js#L425-L446
    field.type = new LimitedLengthType(field.type, this.args.max);
  }
}

const schema = makeExecutableSchema({
  typeDefs,
  directiveVisitors: {
    length: LengthVisitor
});
```

### Synthesizing unique IDs

Suppose your database uses an incrementing ID for each resource type, so IDs are not unique across all resource types. Here's how you might synthesize a field called `uid` that combines the object type with the non-unique ID to produce an ID that's unique across your schema:

```typescript
const typeDefs = `
type Person @uniqueID(name: "uid", from: ["personID"]) {
  personID: Int
  name: String
}

type Location @uniqueID(name: "uid", from: ["locationID"]) {
  locationID: Int
  address: String
}`;

class UniqueIDVisitor extends SchemaDirectiveVisitor {
  visitObject(type) {
    const { name, from } = this.args;
    type.getFields()[name] = {
      name: name,
      type: GraphQLID,
      description: 'Unique ID',
      args: [],
      resolve(object) {
        const hash = require("crypto").createHash("sha256");
        hash.update(type.name);
        from.forEach(fieldName => {
          hash.update(String(object[fieldName]));
        });
        return hash.digest("hex");
      }
    };
  }
}

const schema = makeExecutableSchema({
  typeDefs,
  directiveVisitors: {
    uniqueID: UniqueIDVisitor
  }
});
```

## What about `directiveResolvers`?

Before `SchemaDirectiveVisitor` was implemented, the `makeExecutableSchema` function took a `directiveResolvers` option that could be used for implementing certain kinds of `@directive`s on fields that have resolver functions.

The new abstraction is more general, since it can visit any kind of schema syntax, and do much more than just wrap resolver functions. However, the old `directiveResolvers` API has been [left in place](directive-resolvers.md) for backwards compatibility, though it is now implemented in terms of `SchemaDirectiveVisitor`:

```typescript
function attachDirectiveResolvers(
  schema: GraphQLSchema,
  directiveResolvers: IDirectiveResolvers<any, any>,
) {
  const directiveVisitors = Object.create(null);

  Object.keys(directiveResolvers).forEach(directiveName => {
    directiveVisitors[directiveName] = class extends SchemaDirectiveVisitor {
      public visitFieldDefinition(field: GraphQLField<any, any>) {
        const resolver = directiveResolvers[directiveName];
        const originalResolver = field.resolve || defaultFieldResolver;
        const directiveArgs = this.args;
        field.resolve = (...args: any[]) => {
          const [source, /* original args */, context, info] = args;
          return resolver(
            async () => originalResolver.apply(field, args),
            source,
            directiveArgs,
            context,
            info,
          );
        };
      }
    };
  });

  SchemaDirectiveVisitor.visitSchemaDirectives(
    schema,
    directiveVisitors,
  );
}
```

Existing code that uses `directiveResolvers` should probably consider migrating to `SchemaDirectiveVisitor` if feasible, though we have no immediate plans to deprecate `directiveResolvers`.
