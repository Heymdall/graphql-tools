import {
  DirectiveLocation,
  DirectiveLocationEnum,
  GraphQLArgument,
  GraphQLDirective,
  GraphQLEnumType,
  GraphQLEnumValue,
  GraphQLField,
  GraphQLInputField,
  GraphQLInputObjectType,
  GraphQLInterfaceType,
  GraphQLNamedType,
  GraphQLObjectType,
  GraphQLScalarType,
  GraphQLSchema,
  GraphQLUnionType,
  Kind,
  ValueNode,
} from 'graphql';

import {
  getArgumentValues,
} from 'graphql/execution/values';

export type VisitableType =
    GraphQLSchema
  | GraphQLObjectType
  | GraphQLInterfaceType
  | GraphQLNamedType
  | GraphQLScalarType
  | GraphQLField<any, any>
  | GraphQLArgument
  | GraphQLUnionType
  | GraphQLEnumType
  | GraphQLEnumValue;

const hasOwn = Object.prototype.hasOwnProperty;

// This class represents a reusable implementation of a @directive that may
// appear in a GraphQL schema written in Schema Definition Language.
//
// By overriding one or more visit{Object,Union,...} methods, a subclass
// registers interest in certain schema types, such as GraphQLObjectType,
// GraphQLUnionType, and so on. When SchemaDirectiveVisitor.visitSchema is
// called with a GraphQLSchema object and a map of visitor subclasses, the
// overidden methods of those subclasses allow the visitors to obtain
// references to any type objects that have @directives attached to them,
// enabling the visitors to inspect or modify the schema as appropriate.
//
// For example, if a directive called @rest(url: "...") appears after a field
// definition, a SchemaDirectiveVisitor subclass could provide meaning to that
// directive by overriding the visitFieldDefinition method (which receives a
// GraphQLField parameter), and then the body of that visitor method could
// manipulate the field's resolver function to fetch data from a REST endpoint
// described by the url argument passed to the @rest directive:
//
//   const typeDefs = `
//   type Query {
//     people: [Person] @rest(url: "/api/v1/people")
//   }`;
//
//   const schema = makeExecutableSchema({ typeDefs });
//
//   SchemaDirectiveVisitor.visitSchema(schema, {
//     rest: class extends SchemaDirectiveVisitor {
//       visitFieldDefinition(field: GraphQLField<any, any>) {
//         const { url } = this.args;
//         field.resolve = () => fetch(url);
//       }
//     }
//   });
//
// The subclass in this example is defined as an anonymous class expression,
// for brevity. A truly reusable SchemaDirectiveVisitor would most likely be
// defined in a library using a named class declaration, and then exported for
// consumption by other modules and packages.
//
// See below for a complete list of overridable visitor methods, their
// parameter types, and more details about the properties exposed by instances
// of the SchemaDirectiveVisitor class.

export class SchemaDirectiveVisitor {
  // The name of the directive this visitor is allowed to visit (that is, the
  // identifier that appears after the @ character in the schema). Note that
  // this property is per-instance rather than static because subclasses of
  // SchemaDirectiveVisitor can be instantiated multiple times to visit
  // directives of different names. In other words, SchemaDirectiveVisitor
  // implementations are effectively anonymous, and it's up to the caller of
  // SchemaDirectiveVisitor.visitSchema to assign names to them.
  public name: string;

  // A map from parameter names to argument values, as obtained from a
  // specific occurrence of a @directive(arg1: value1, arg2: value2, ...) in
  // the schema. Visitor methods may refer to this object via this.args.
  public args: { [name: string]: any };

  // All SchemaDirectiveVisitor instances are created while visiting a
  // specific GraphQLSchema object, so this property holds a reference to that
  // object, in case a vistor method needs to refer to this.schema.
  public schema: GraphQLSchema;

  // A reference to the type object that this visitor was created to visit.
  public visitedType: VisitableType;

  // Call SchemaDirectiveVisitor.visitSchema(schema, directiveVisitors) to
  // visit every @directive in the schema and instantiate an appropriate
  // SchemaDirectiveVisitor subclass to visit/handle/transform the object
  // decorated by the @directive.
  public static visitSchema(
    schema: GraphQLSchema,
    directiveVisitors: {
      // The keys of this object correspond to directive names as they appear
      // in the schema, and the values should be subclasses (not instances!)
      // of the SchemaDirectiveVisitor class. This distinction is important
      // because a new SchemaDirectiveVisitor instance will be created each
      // time a matching directive is found in the schema AST, with arguments
      // and other metadata specific to that occurrence. To help prevent the
      // mistake of passing instances, the SchemaDirectiveVisitor constructor
      // method is marked as protected.
      [directiveName: string]: typeof SchemaDirectiveVisitor
    },
  ) {
    // If the schema declares any directives for public consumption, record
    // them here so that we can properly coerce arguments when/if we encounter
    // an occurrence of the directive while walking the schema below.
    const declaredDirectives: {
      [key: string]: GraphQLDirective,
    } = Object.create(null);
    schema.getDirectives().forEach(decl => {
      declaredDirectives[decl.name] = decl;
    });

    // Recursive helper for visiting nested schema type objects.
    function visit(type: VisitableType) {
      if (type instanceof GraphQLSchema) {
        getDirectives(type).forEach(d => {
          // This call type-checks because it's lexically nested inside the
          // `type instanceof GraphQLSchema` conditional block. The same is
          // true of every other directive.visit* method call below.
          d.visitSchema(type);
        });

        each(type.getTypeMap(), (namedType, typeName) => {
          if (! typeName.startsWith('__')) {
            // Call visit recursively to let it determine which concrete
            // subclass of GraphQLNamedType we found in the type map.
            visit(namedType);
          }
        });

      } else if (type instanceof GraphQLObjectType) {
        // Note that getDirectives(type) will often return an empty array,
        // when there are no @directive annotations associated with this type.
        getDirectives(type).forEach(d => {
          d.visitObject(type);
        });

        visitFields(type);

      } else if (type instanceof GraphQLInterfaceType) {
        getDirectives(type).forEach(d => {
          d.visitInterface(type);
        });

        visitFields(type);

      } else if (type instanceof GraphQLInputObjectType) {
        getDirectives(type).forEach(d => {
          d.visitInputObject(type);
        });

        each(type.getFields(), field => {
          getDirectives(field).forEach(df => {
            // Since we call a different method for input object fields, we
            // can't reuse the visitFields function here.
            df.visitInputFieldDefinition(field, {
              objectType: type,
            });
          });
        });

      } else if (type instanceof GraphQLScalarType) {
        getDirectives(type).forEach(d => {
          d.visitScalar(type);
        });

      } else if (type instanceof GraphQLUnionType) {
        getDirectives(type).forEach(d => {
          d.visitUnion(type);
        });

        // The GraphQL schema parser currently does not support @directive
        // syntax for union member types, so there's no point visiting them
        // here. That's a blessing in disguise, really, because the types
        // returned from type.getTypes() are references to GraphQLObjectType
        // objects defined elsewhere in the schema, which might be decorated
        // with directives of their own, so it would be hard to prevent this
        // loop from re-visiting those directives. To access the member types
        // of a union, just implement a SchemaDirectiveVisitor that overrides
        // visitUnion, and call unionType.getTypes() yourself.

        // type.getTypes().forEach(visit);

      } else if (type instanceof GraphQLEnumType) {
        getDirectives(type).forEach(d => {
          d.visitEnum(type);
        });

        type.getValues().forEach(value => {
          getDirectives(value).forEach(dv => {
            dv.visitEnumValue(value, {
              enumType: type,
            });
          });
        });
      }
    }

    function visitFields(type: GraphQLObjectType | GraphQLInterfaceType) {
      each(type.getFields(), field => {
        // It would be nice if we could call visit(field) recursively here,
        // but GraphQLField is merely a type, not a value that can be detected
        // using an instanceof check, so we have to visit the fields in this
        // lexical context, so that TypeScript can validate the call to
        // visitFieldDefinition.
        getDirectives(field).forEach(df => {
          // While any field visitor needs a reference to the field object,
          // some field visitors may also need to know the enclosing (parent)
          // type, perhaps to determine if the parent is a GraphQLObjectType
          // or a GraphQLInterfaceType. To obtain a reference to the parent, a
          // visitor method can have a second parameter, which will be an
          // object with an .objectType property referring to the parent.
          df.visitFieldDefinition(field, {
            objectType: type,
          });
        });

        if (field.args) {
          field.args.forEach(arg => {
            getDirectives(arg).forEach(da => {
              // Like visitFieldDefinition, visitArgumentDefinition takes a
              // second parameter that provides additional context, namely the
              // parent .field and grandparent .objectType. Remember that the
              // current GraphQLSchema is always available via this.schema.
              da.visitArgumentDefinition(arg, {
                field,
                objectType: type,
              });
            });
          });
        }
      });
    }

    // Given a schema type, returns an (often empty) array of directives that
    // should be applied to the given type.
    function getDirectives(type: VisitableType): SchemaDirectiveVisitor[] {
      const directiveInstances: SchemaDirectiveVisitor[] = [];
      const directiveNodes = type.astNode && type.astNode.directives;
      if (! directiveNodes) {
        return directiveInstances;
      }

      directiveNodes.forEach(directiveNode => {
        const name = directiveNode.name.value;
        if (! hasOwn.call(directiveVisitors, name)) {
          return;
        }

        const directiveClass = directiveVisitors[name];
        const decl = declaredDirectives[name];
        let args: { [key: string]: any };

        if (decl) {
          // If this directive was explicitly declared, use the declared
          // argument types (and any default values) to check, coerce, and/or
          // supply default values for the given arguments.
          args = getArgumentValues(decl, directiveNode);
        } else {
          // If this directive was not explicitly declared, just convert the
          // argument nodes to their corresponding JavaScript values.
          args = Object.create(null);
          directiveNode.arguments.forEach(arg => {
            args[arg.name.value] = valueFromASTUntyped(arg.value);
          });
        }

        // As foretold in comments near the top of the visitSchema method,
        // this is where instances of the SchemaDirectiveVisitor class get
        // created and assigned names. Subclasses can override the constructor
        // method, but since the constructor is marked as protected, these are
        // the only arguments that will ever be passed.
        directiveInstances.push(new directiveClass({
          name,
          args,
          visitedType: type,
          schema
        }));
      });

      return directiveInstances;
    }

    // Kick everything off by visiting the top-level GraphQLSchema object.
    visit(schema);

    // TODO Should visitSchema return anything?
  }

  // Mark the constructor protected to enforce passing SchemaDirectiveVisitor
  // subclasses (not instances) to visitSchema.
  protected constructor(config: {
    name: string,
    args: { [name: string]: any },
    visitedType: VisitableType,
    schema: GraphQLSchema,
  }) {
    this.name = config.name;
    this.args = config.args;
    this.visitedType = config.visitedType;
    this.schema = config.schema;
  }

  // Concrete subclasses of SchemaDirectiveVisitor should override one or more
  // of these visitor methods, in order to express their interest in handling
  // certain schema types and/or locations. Much of the complexity of this
  // class (especially the visit helper function used within visitSchema) is
  // necessary so that these methods can have specific parameter types, rather
  // than something generic like GraphQLNamedType.
  /* tslint:disable:no-empty */
  public visitSchema(schema: GraphQLSchema) {}
  public visitScalar(scalar: GraphQLScalarType) {}
  public visitObject(object: GraphQLObjectType) {}
  public visitFieldDefinition(field: GraphQLField<any, any>, details: {
    objectType: GraphQLObjectType | GraphQLInterfaceType,
  }) {}
  public visitArgumentDefinition(argument: GraphQLArgument, details: {
    field: GraphQLField<any, any>,
    objectType: GraphQLObjectType | GraphQLInterfaceType,
  }) {}
  public visitInterface(iface: GraphQLInterfaceType) {}
  public visitUnion(union: GraphQLUnionType) {}
  public visitEnum(type: GraphQLEnumType) {}
  public visitEnumValue(value: GraphQLEnumValue, details: {
    enumType: GraphQLEnumType,
  }) {}
  public visitInputObject(object: GraphQLInputObjectType) {}
  public visitInputFieldDefinition(field: GraphQLInputField, details: {
    objectType: GraphQLInputObjectType,
  }) {}
  /* tslint:enable:no-empty */

  // When subclasses of SchemaDirectiveVisitor override the visitor methods
  // defined above, this.locations can be populated automatically with the
  // corresponding DirectiveLocationEnum strings where the directive is
  // allowed to appear. For example, when a subclass overrides the visitUnion
  // method, the "UNION" enum value will be included in this list. These
  // locations take precedence over any locations declared using the
  // `directive @myDirective on OBJECT | INTERFACE | ...` syntax, as far as
  // visitSchema is concerned.
  /* tslint:disable:member-ordering */
  private static locations: DirectiveLocationEnum[] = null;
  public static getLocations() {
    if (this.locations === null) {
      this.locations = [];
      for (let key in this.prototype) {
        if (hasOwn.call(methodToLocationMap, key)) {
          const method = this.prototype[key];
          if (typeof method === 'function' &&
              ! visitMethodStubSet.has(method)) {
            this.locations.push(methodToLocationMap[key]);
          }
        }
      }
    }
    return this.locations;
  } /* tslint:enable:member-ordering */
}

// Map from visitor method names to corresponding schema locations where
// directives can appear. Although the visitor methods follow a naming scheme
// directly inspired by the names of DirectiveLocation enum values (meaning we
// could technically populate this mapping automatically), it's not much more
// verbose to write out all the mappings, and that also gives us more
// flexibility in naming new methods in the future.
const methodToLocationMap: {
  [methodName: string]: DirectiveLocationEnum
} = {
  visitSchema: DirectiveLocation.SCHEMA,
  visitScalar: DirectiveLocation.SCALAR,
  visitObject: DirectiveLocation.OBJECT,
  visitFieldDefinition: DirectiveLocation.FIELD_DEFINITION,
  visitArgumentDefinition: DirectiveLocation.ARGUMENT_DEFINITION,
  visitInterface: DirectiveLocation.INTERFACE,
  visitUnion: DirectiveLocation.UNION,
  visitEnum: DirectiveLocation.ENUM,
  visitEnumValue: DirectiveLocation.ENUM_VALUE,
  visitInputObject: DirectiveLocation.INPUT_OBJECT,
  visitInputFieldDefinition: DirectiveLocation.INPUT_FIELD_DEFINITION,
};

// Used internally to check that a visitor method is not an empty stub
// inherited from SchemaDirectiveVisitor.prototype.
const visitMethodStubSet = new Set(
  Object.keys(methodToLocationMap).map(
    key => SchemaDirectiveVisitor.prototype[key]
  )
);

// Helper widely used in the visit function above.
function each<V>(
  obj: { [key: string]: V },
  callback: (value: V, key: string) => void,
) {
  Object.keys(obj).forEach(key => {
    callback(obj[key], key);
  });
}

// Similar to the graphql-js function of the same name, slightly simplified:
// https://github.com/graphql/graphql-js/blob/master/src/utilities/valueFromASTUntyped.js
function valueFromASTUntyped(
  valueNode: ValueNode,
): any {
  switch (valueNode.kind) {
  case Kind.NULL:
    return null;
  case Kind.INT:
    return parseInt(valueNode.value, 10);
  case Kind.FLOAT:
    return parseFloat(valueNode.value);
  case Kind.STRING:
  case Kind.ENUM:
  case Kind.BOOLEAN:
    return valueNode.value;
  case Kind.LIST:
    return valueNode.values.map(valueFromASTUntyped);
  case Kind.OBJECT:
    const obj = Object.create(null);
    valueNode.fields.forEach(field => {
      obj[field.name.value] = valueFromASTUntyped(field.value);
    });
    return obj;
  /* istanbul ignore next */
  default:
    throw new Error('Unexpected value kind: ' + valueNode.kind);
  }
}
