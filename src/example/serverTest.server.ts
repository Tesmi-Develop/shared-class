import { StartServer } from "..";
import { TestSharedClass } from "./sharedClassTest";

StartServer();

const instance = new TestSharedClass('Test1');
instance.Init();

const instance2 = new TestSharedClass('Test2');
instance2.Init();