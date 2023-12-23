import Maid from "@rbxts/maid";
import { Client, Server, createRemotes, remote } from "@rbxts/remo"
import { RunService } from "@rbxts/services";
import Signal from "@rbxts/signal";
import { t } from "@rbxts/t";
import { $terrify } from "rbxts-transformer-t-new";

type Constructor<T = object> = new (...args: never[]) => T;
type ObjectKey = string | number | symbol
export type SharedClassId = string;

interface ISharedClass {
    Name: string;
    Constructor: Constructor;
    OnCreate: Signal<(instance: object) => void>;
    OnPlayerReplicated: Signal<(instance: object, player: Player) => void>;
    NonSynchronized: Set<string>;
    ServerMethods: Set<string>;
    HydrationMethods: Set<string>;
}

interface ISharedInstance {
	sharedClass: ISharedClass;
	Id: SharedClassId
	Instance: object;
	InitedPlayers: Set<Player>;
	IsInitedClient: boolean;
	Maid: Maid;
}

interface IPackageCallMethod {
    methodName: string;
    args: unknown[];
}

enum PackageTypeServer {
    callMethod,
    hydration
}

enum PackageTypeClient {
	OnCreatedInstance,
    callMethod,
}

const remotes = createRemotes({
	OnRequestSharedClasses: remote<Server, []>(),
	CreateSharedInstance: remote<Client, [SharedClassId, string, unknown[], Map<string, unknown>, ObjectKey | undefined]>(t.string, t.string, t.array(t.any), t.map(t.string, t.any), t.optional(t.union(t.string, t.number))),
	SharedClassesCommunicationServer: remote<Client, [SharedClassId, PackageTypeServer, object]>(t.string, t.number, t.table),
	SharedClassesCommunicationClient: remote<Server, [SharedClassId, PackageTypeClient, object]>(t.string, t.number, t.table),
    SharedClassesUnreliableCommunicationServer: remote<Client, [SharedClassId, PackageTypeServer, object]>(t.string, t.number, t.table).unreliable(),
	SharedClassesUnreliableCommunicationClient: remote<Server, [SharedClassId, PackageTypeClient, object]>(t.string, t.number, t.table).unreliable(),
});

const createGeneratorId = () => {
	const generator = {
		freeId: '0',

		next: (): SharedClassId => {
			const id  = tonumber(generator.freeId)!;
			generator.freeId = `${id + 1}`;
			return `${id}`;
		}
	}

	return generator;
}

const SharedClasses = new Map<string, ISharedClass>();
const SharedInstances = new Map<object, ISharedInstance>();
const SharedInstancesById = new Map<SharedClassId, ISharedInstance>();

let isStarterClient = false;
let isStarterServer = false;
const isServer = RunService.IsServer();
const isClient = RunService.IsClient();
const OnRequestSharedClasses = new Signal<(Player: Player) => void>();
const RequestedPlayers = new Set<Player>();
const QueueCreateSharedInstance = new Set<SharedClassId>();
const generatorId = createGeneratorId();

export const StartServer = () => {
	assert(isServer, 'StartServer can only be called on the server');
    if (isStarterServer) return;
    isStarterServer = true;

	remotes.OnRequestSharedClasses.connect((player) => {
		if (RequestedPlayers.has(player)) return;
		RequestedPlayers.add(player);
		OnRequestSharedClasses.Fire(player);
	});

    const callbackCommunication = (player: Player, id: SharedClassId, methodType: PackageTypeClient, data: object) => {
		const sharedInstance = SharedInstancesById.get(id);
		if (!sharedInstance) return;

		if (methodType === PackageTypeClient.OnCreatedInstance) {
			if (sharedInstance.InitedPlayers.has(player)) return;
            sharedInstance.InitedPlayers.add(player);
		} 

		if (methodType === PackageTypeClient.callMethod) {
			const validator = $terrify<IPackageCallMethod>();
			if (!validator(data)) return;

			const sharedClass = getSharedClass(sharedInstance.sharedClass);
			if (!sharedClass.ServerMethods.has(data.methodName)) return;

			const args = data.args as unknown[];
			const callback = sharedInstance.Instance[data.methodName as never] as Callback;
			callback(sharedInstance.Instance, ...args);
		}
	}

	remotes.SharedClassesCommunicationClient.connect(callbackCommunication);
    remotes.SharedClassesUnreliableCommunicationClient.connect(callbackCommunication);
}

export const StartClient = () => {
	assert(isClient, 'StartClient can only be called on the client');
    if (isStarterClient) return;
    isStarterClient = true

	remotes.CreateSharedInstance.connect((id, sharedClassName, args, properties, clientMethodInitName) => {
        if (!SharedClasses.has(sharedClassName)) {
            warn(`Class ${sharedClassName} does not exist but server sent it`);
            return;
        }
    
        const object = SharedClasses.get(sharedClassName)!;
        
        QueueCreateSharedInstance.add(id);
        const instance = new object.Constructor(id as never, ...(args as never[]));
        QueueCreateSharedInstance.delete(id);

		// Sync properties
        properties.forEach((data, propertyName) => {
            instance[propertyName as never] = data as never;
        });

        if (clientMethodInitName) {
            (instance[clientMethodInitName as never] as Callback)(instance);
        }
    });

    const callbackCommunication = (id: SharedClassId, methodType: PackageTypeServer, data: object) => {
        const sharedInstance = SharedInstancesById.get(id);
        if (!sharedInstance) return;

        if (methodType === PackageTypeServer.callMethod) {
            const castedData = data as IPackageCallMethod;
            const callback = sharedInstance.Instance[castedData.methodName as never] as Callback;
            callback(sharedInstance.Instance, ...castedData.args);
        }
    
        if (methodType === PackageTypeServer.hydration) {
            const castedData = data as {properties: Map<string, unknown>};
            const sharedClass = sharedInstance.sharedClass;
    
            castedData.properties.forEach((data, propertyName) => {
                sharedInstance.Instance[propertyName as never] = data as never;
            });
    
            sharedClass?.HydrationMethods.forEach((method) => {
                const callback = sharedInstance.Instance[method as never] as Callback;
                callback(sharedInstance.Instance as never);
            });
        }
    }

    remotes.SharedClassesCommunicationServer.connect(callbackCommunication);
    remotes.SharedClassesUnreliableCommunicationServer.connect(callbackCommunication);

    remotes.OnRequestSharedClasses.fire();
}

//#region Utility Functions
const getClassName = <T extends object>(obj: T) => `${obj}`;

const createSharedClass = (object: object) => {
	const name = getClassName(object);
	SharedClasses.set(name, {
        Name: name,
		Constructor: object as Constructor,
		OnCreate: new Signal(),
		OnPlayerReplicated: new Signal(),
		NonSynchronized: new Set(),
		ServerMethods: new Set(),
		HydrationMethods: new Set(),
	});

    return SharedClasses.get(name)!;
}

const SendPackageServer = <D extends object>(object: object, methodType: PackageTypeServer, data: D, isUnreliable: boolean) => {
    assert(isServer, 'SendPackageServer can only be called on the server');

    const instance = SharedInstances.get(object);
    assert(instance, 'This class is not shared. Please use @SharedClass');

    if (isUnreliable) {
        remotes.SharedClassesUnreliableCommunicationServer.fireAll(instance.Id, methodType, data);
        return;
    }

	remotes.SharedClassesCommunicationServer.fireAll(instance.Id, methodType, data);
}

const SendPackageClient = <D extends object>(object: object, methodType: PackageTypeClient, data: D, isUnreliable: boolean) => {
    assert(isClient, 'SendPackage can only be called on the client');

    const instance = SharedInstances.get(object);
    assert(instance, 'This class is not shared. Please use @SharedClass');

    if (isUnreliable) {
        remotes.SharedClassesUnreliableCommunicationClient.fire(instance.Id, methodType, data);
        return;
    }

    remotes.SharedClassesCommunicationClient.fire(instance.Id, methodType, data);
}

const createInstanceSharedClass = (object: object, id: SharedClassId) => {
	const instance = {
		sharedClass: SharedClasses.get(getClassName(getmetatable(object) as object))!,
		Id: id,
		Instance: object,
		InitedPlayers: new Set<Player>(),
		IsInitedClient: false,
		Maid: new Maid(),
	}

	SharedInstances.set(object, instance);
	SharedInstancesById.set(id, instance);

	return instance;
}

const removeInstanceSharedClass = (object: object) => {
	SharedInstancesById.delete(SharedInstances.get(object)!.Id);
	SharedInstances.delete(object);
}

const getSharedClass = (object: object) => {
    if (!SharedClasses.has(`${object}`)) {
        return createSharedClass(object);
    }
    return SharedClasses.get(`${object}`)!;
}

const generateReplicatedProperties = (object: object) => {
    const sharedClass = getSharedClass(getmetatable(object) as object);
    const data = new Map<string, unknown>();

	for (const [key, value] of pairs(object)) {
		const propertyName = key as string;

		if (sharedClass.NonSynchronized.has(propertyName)) continue;
		if (typeIs(value, 'table') && getmetatable(value) !== undefined) continue;

		data.set(propertyName, object[propertyName as never]);
	}

    return data
}
//#endregion

//#region Decorators
export const SharedMethod = (isUnreliable = false) => {
    return (object: object, propertyName: string, description: TypedPropertyDescriptor<Callback>) => {
        if (isServer) {
            const originalMethod = description.value;
            
            description.value = function(this, ...args: unknown[]) {
                SendPackageServer(this, PackageTypeServer.callMethod, {
                    methodName: propertyName,
                    args: args,
                }, isUnreliable);

                return originalMethod(this, ...args);
            }
        }

        return description;
    }
}

export const NonSyncedProperty = () => {
    return (object: object, propertyName: string) => {
        const sharedClass = getSharedClass(object);
        sharedClass.NonSynchronized.add(propertyName);
    }
}

export const OnHydration = () => {
    return (object: object, propertyName: string, description: TypedPropertyDescriptor<() => void>) => {
        const sharedClass = getSharedClass(object);
        sharedClass.HydrationMethods.add(propertyName);
    }
}

export const ServerMethod = (isUnreliable = false) => {
    return (object: object, propertyName: string, description: TypedPropertyDescriptor<Callback>) => {
        const originalMethod = description.value;

        const sharedClass = getSharedClass(object);
        sharedClass.ServerMethods.add(propertyName);

        description.value = function(this, ...args: unknown[]) {
            if (isClient) {
                SendPackageClient(this, PackageTypeClient.callMethod, {
                    methodName: propertyName,
                    args: args,
               }, isUnreliable);
               return;
            }
            originalMethod(this, ...args);
        }

        return description;
    }
}

export const ClientMethod = (isUnreliable = false) => {
    return (object: object, propertyName: string, description: TypedPropertyDescriptor<Callback>) => {
        const originalMethod = description.value;

        description.value = function(this, ...args: unknown[]) {
            if (isServer) {
               SendPackageServer(this, PackageTypeServer.callMethod, {
                    methodName: propertyName,
                    args: args,
               }, isUnreliable);
               return;
            }
            originalMethod(this, ...args);
        }

        return description;
    }
}


interface SharedClassConfig<K extends ObjectKey = string, D extends ObjectKey = string> {
    ClientMethodInitName?: K,
    DestroyMethodName?: D
    HydrationRate?: number;
}

type ExtractMethods <C> = ExtractMembers<C, Callback>

const HaveDestroyMethod = (object: object): object is { Destroy: Callback }  => 'Destroy' in object && typeIs(object.Destroy, 'function');

export const SharedClass = <T extends object, K extends keyof ExtractMethods<T>, D extends ExtractMethods<T>>({
    ClientMethodInitName,
    DestroyMethodName,
    HydrationRate
}: SharedClassConfig<K, keyof D> = {}) => {
    return (sharedClass: Constructor<T>) => {
        const objectWithconstructor = sharedClass as unknown as { constructor: (...args: defined[]) => unknown };
        const originalConstructor = objectWithconstructor.constructor;
        getSharedClass(sharedClass);
		
		const className = getClassName(sharedClass);

        objectWithconstructor.constructor = function(this, ...args: defined[]) {
            if (isClient) {
                if (!typeIs(args[0], 'string') || !QueueCreateSharedInstance.has(args[0])) {
                    originalConstructor(this, ...args);
                    return;
                }
            }
            let id = isServer ? generatorId.next() : args[0] as SharedClassId;
			const instanceData = createInstanceSharedClass(this, id);
			const maid = instanceData.Maid;

			maid.GiveTask(() => removeInstanceSharedClass(this));

            // Server code
            if (isServer) {
                originalConstructor(this, ...args);

                remotes.CreateSharedInstance.fireAll(instanceData.Id, className, args, generateReplicatedProperties(this), ClientMethodInitName);

                if (HydrationRate) {
                    maid.GiveTask(task.spawn(() => {
                        while (true) {
                            task.wait(HydrationRate!);
                            SendPackageServer(this, PackageTypeServer.hydration, {
                                properties: generateReplicatedProperties(this),
                            }, false);
                        }
                    }));
                }

                maid.GiveTask(OnRequestSharedClasses.Connect((player) => {
                    remotes.CreateSharedInstance.fire(player, instanceData.Id, className, args, generateReplicatedProperties(this), ClientMethodInitName);
                }));
                
                return;
            }

            // Client code
            args.remove(0);

            originalConstructor(this, ...args);
            remotes.SharedClassesCommunicationClient.fire(id, PackageTypeClient.OnCreatedInstance, {});
        }

        if (DestroyMethodName || HaveDestroyMethod(objectWithconstructor)) {
            const objectWithDestroy = objectWithconstructor as unknown as { Destroy: (...args: defined[]) => void }; 
            const originalDestroy = objectWithDestroy[(DestroyMethodName || 'Destroy') as never] as Callback;

            objectWithDestroy[(DestroyMethodName || 'Destroy') as never] = function(context: typeof objectWithconstructor, ...args: defined[]) {
                if (isServer) {
                    SendPackageServer(context, PackageTypeServer.callMethod, {
                        methodName: 'Destroy',
                        args: args,
                    }, false);
                }
                originalDestroy(context, ...args);
                SharedInstances.get(context)!.Maid.DoCleaning();
            } as never;
        }
    }
}
//#endregion

export const GetSharedInstance = (id: SharedClassId) => {
    return SharedInstancesById.get(id)?.Instance;
}