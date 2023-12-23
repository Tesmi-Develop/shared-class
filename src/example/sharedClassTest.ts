import { RunService } from "@rbxts/services";
import { ClientMethod, NonSyncedProperty, OnHydration, SharedClass, SharedMethod } from "..";

@SharedClass({
    ClientMethodInitName: 'InitClient',
    HydrationRate: 5
})
export class TestSharedClass {
    private test = 0;
    private name: string;

    @NonSyncedProperty()
    private test2 = 0;

    constructor(name: string) {
        this.name = name;
    }

    @OnHydration()
    private onHyd() {
        print('onHyd', this.test);
    }

    @ClientMethod(true)
    private syncProp(value: number) {
        this.test = value;
        print(`syncProp: ${this.test}`);
    }

    @SharedMethod()
    private sharedMethod() {
        print(`Invoke sharedMethod from ${RunService.IsServer() ? 'server' : 'client'} with name ${this.name}`);
    }

    public Destroy() {
        print('Destroy', this.name);
    }

    public Init() {
        this.test2 = 12;
        const thread = task.spawn(() => {
            while(true) {
                task.wait(1);
                this.test += 1
                //this.sharedMethod();
                this.syncProp(this.test);

                if (this.test > 10) {
                    this.Destroy();
                    break
                }
            }
        });
    }

    public InitClient() {
        print(`test2 = ${this.test2}`);
    }
}