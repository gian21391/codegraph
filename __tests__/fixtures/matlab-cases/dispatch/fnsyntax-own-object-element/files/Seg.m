classdef Seg < handle
    methods
        function b = anyJoint(ets)
            e = ets(1);
            b = isfixed(e);
            for x = ets
                b = b || isfixed(x);
            end
            b = b || scaled(2, ets) > 0;
        end
        function b = other(ets)
            n = ets(1);
            n = 3;
            b = isfixed(n);
        end
        function t = isfixed(e)
            t = true;
        end
        function v = scaled(f, e)
            v = f;
        end
    end
end
