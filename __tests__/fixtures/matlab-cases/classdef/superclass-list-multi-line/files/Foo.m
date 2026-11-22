classdef Foo < Bar & ... base one
        Baz
    methods
        function go(obj)
            obj.fromBar();
            obj.fromBaz();
        end
    end
end
